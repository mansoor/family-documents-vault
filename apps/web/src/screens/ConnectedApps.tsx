import {
  APP_BACKFILL_MAX_DAYS,
  APP_DEFAULT_DAILY_BYTES,
  APP_DEFAULT_DAILY_FILES,
  APP_IP_ALLOW_MAX,
  APP_NAME_MAX,
  APP_REFUSAL_SHORT,
  APP_SCOPE_WORDS,
  APP_STATE_WORDS,
  appsNotPublicWords,
  localToday,
  NOTE_KIND,
  roleLabel,
  type AppKeyView,
  type ConnectedAppChange,
  type ConnectedAppInput,
  type ConnectedAppList,
  type ConnectedAppView,
  type DocumentTypeView,
  type Member,
  type Visibility,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { dayWordsOf, familyZoneNow, shortWhenWords } from '../family-time.js';
import { storedRole } from '../session.js';
import { Button, Check, ConfirmDialog, ErrorNote, Field, LoadFailed, Select } from '../ui.js';
import { SettingsPage } from './Settings.js';

/**
 * Connected apps (/settings/connected-apps, 0.9.0 APP1): an app an owner
 * connects, which signs what it sends with its own key and sends documents
 * into the Inbox of the person it acts as — an owner or an adult who signs
 * in. It can only send.
 *
 * An owner sees every app, connects one (a passkey or an authenticator's
 * code, never the password: `connect_app`), pauses it, turns it back on,
 * changes what it may do, adds and retires its keys, and removes it. An
 * adult sees only the apps acting as them: turns one on (it waits for them
 * when an owner connected it as them), and removes it. What it sent that
 * waits, and was filed, is its person's alone to see.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;

/** "0 MB", "640 KB", "3 MB", "1.5 GB": a day's bytes, as Settings says them. */
export function amountWords(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round((bytes / GB) * 10) / 10} GB`;
}

/** "12 of 100 files today, 3 MB of 500 MB". */
export function todayWords(app: Pick<ConnectedAppView, 'today' | 'daily_files' | 'daily_bytes'>) {
  return `${app.today.files} of ${app.daily_files} files today, ${amountWords(app.today.bytes)} of ${amountWords(app.daily_bytes)}`;
}

/** A day as the page says it: "23 November", on the family's calendar. */
const day = (iso: string) => dayWordsOf(iso, familyZoneNow(), { year: 'other' });

/** Whom it acts as, for the reader: "you", or their name. */
const whom = (app: Pick<ConnectedAppView, 'mine' | 'member_name'>) =>
  app.mine ? 'you' : app.member_name;

/** Its state in words; a pause says by whom. */
function stateWords(app: ConnectedAppView): string {
  if (app.state === 'paused') {
    return app.paused_reason === 'restored' ? 'Paused after the restore' : 'Paused by an owner';
  }
  if (app.state === 'waiting_for_approval') {
    return app.mine ? 'Waiting for you to turn it on' : APP_STATE_WORDS.waiting_for_approval;
  }
  return APP_STATE_WORDS[app.state];
}

const STATE_CLASS: Record<ConnectedAppView['state'], string> = {
  active: 'status status-ok',
  paused: 'status status-warn',
  waiting_for_approval: 'status status-neutral',
};

/** Who sees what it sends: null as each kind says. */
function seenWords(v: Visibility | null, who: string): string {
  if (v === null) return 'As each kind says';
  if (v === 'adults') return 'Adults only';
  if (v === 'household') return 'Everyone';
  return who === 'you' ? 'Only me' : `Only ${who}`;
}

// ------------------------------------------------------------------ the form

/** The form's fields, as typed. */
interface AppForm {
  name: string;
  member: string;
  key: string;
  kinds: string[];
  /** '' is "as each kind says". */
  seen: '' | Visibility;
  files: string;
  mb: string;
  ip: string;
  backfill: boolean;
  until: string;
  backfillFiles: string;
  backfillMb: string;
}

type Ceilings = ConnectedAppList['ceilings'];

/** What the form says, checked: or what is wrong, in words. */
type Read =
  | {
      ok: true;
      value: Omit<ConnectedAppInput, 'member_id' | 'public_key'> & { ip_allow: string[] };
    }
  | { ok: false; error: string };

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);

const whole = (text: string, lo: number, hi: number): number | null => {
  const t = text.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
};

/** The last day a backfill may end on, and the first: today and 30 days ahead, on the family's calendar. */
function backfillDays(): { min: string; max: string } {
  const zone = familyZoneNow();
  return {
    min: localToday(zone),
    max: localToday(zone, new Date(Date.now() + APP_BACKFILL_MAX_DAYS * DAY - 60_000)),
  };
}

/** The moment a backfill ends: the end of the day chosen, never past 30 days from now. */
function backfillUntil(ymd: string): string {
  const end = new Date(`${ymd}T23:59:59`).getTime();
  return new Date(Math.min(end, Date.now() + APP_BACKFILL_MAX_DAYS * DAY)).toISOString();
}

function readForm(f: AppForm, ceilings: Ceilings): Read {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Give the app a name.' };
  if (name.length > APP_NAME_MAX) {
    return { ok: false, error: `A name is ${APP_NAME_MAX} characters at most.` };
  }
  const maxMb = Math.floor(ceilings.daily_bytes / MB);
  const files = whole(f.files, 1, ceilings.daily_files);
  if (files === null) return { ok: false, error: `Files a day: 1 to ${ceilings.daily_files}.` };
  const mb = whole(f.mb, 1, maxMb);
  if (mb === null) return { ok: false, error: `MB a day: 1 to ${maxMb}.` };
  const ip = lines(f.ip);
  if (ip.length > APP_IP_ALLOW_MAX) {
    return { ok: false, error: `${APP_IP_ALLOW_MAX} addresses or networks at most.` };
  }
  let backfill: ConnectedAppInput['backfill'] = null;
  if (f.backfill) {
    const { min, max } = backfillDays();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.until) || f.until < min || f.until > max) {
      return {
        ok: false,
        error: `Older papers: choose a day within the next ${APP_BACKFILL_MAX_DAYS} days.`,
      };
    }
    const bf = whole(f.backfillFiles, 1, ceilings.daily_files);
    if (bf === null) {
      return { ok: false, error: `Older papers, files a day: 1 to ${ceilings.daily_files}.` };
    }
    const bm = whole(f.backfillMb, 1, maxMb);
    if (bm === null) return { ok: false, error: `Older papers, MB a day: 1 to ${maxMb}.` };
    backfill = { until: backfillUntil(f.until), files_per_day: bf, bytes_per_day: bm * MB };
  }
  return {
    ok: true,
    value: {
      name,
      allowed_kinds: f.kinds,
      default_visibility: f.seen === '' ? null : f.seen,
      daily_files: files,
      daily_bytes: mb * MB,
      ip_allow: ip,
      backfill,
    },
  };
}

/** A new app's form: nobody's kinds ticked, the vault's own daily caps. */
function blankForm(me: string): AppForm {
  return {
    name: '',
    member: me,
    key: '',
    kinds: [],
    seen: '',
    files: String(APP_DEFAULT_DAILY_FILES),
    mb: String(Math.round(APP_DEFAULT_DAILY_BYTES / MB)),
    ip: '',
    backfill: false,
    until: '',
    backfillFiles: String(APP_DEFAULT_DAILY_FILES),
    backfillMb: String(Math.round(APP_DEFAULT_DAILY_BYTES / MB)),
  };
}

/** An app's form, as it is now. */
function formOf(app: ConnectedAppView): AppForm {
  return {
    name: app.name,
    member: app.member_id,
    key: '',
    kinds: [...app.allowed_kinds],
    seen: app.default_visibility ?? '',
    files: String(app.daily_files),
    mb: String(Math.round(app.daily_bytes / MB)),
    ip: app.ip_allow.join('\n'),
    backfill: app.backfill !== null,
    until: app.backfill ? localToday(familyZoneNow(), new Date(app.backfill.until)) : '',
    backfillFiles: String(app.backfill?.files_per_day ?? app.daily_files),
    backfillMb: String(Math.round((app.backfill?.bytes_per_day ?? app.daily_bytes) / MB)),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** What changed between the form as it started and as it is: only that is sent. */
function changeOf(start: AppForm, now: AppForm, value: Extract<Read, { ok: true }>['value']) {
  const change: ConnectedAppChange = {};
  if (now.name.trim() !== start.name) change.name = value.name;
  if (!sameSet(now.kinds, start.kinds)) change.allowed_kinds = value.allowed_kinds;
  if (now.seen !== start.seen) change.default_visibility = value.default_visibility ?? null;
  if (now.files.trim() !== start.files) change.daily_files = value.daily_files as number;
  if (now.mb.trim() !== start.mb) change.daily_bytes = value.daily_bytes as number;
  if (!sameSet(lines(now.ip), lines(start.ip))) change.ip_allow = value.ip_allow;
  const backfillMoved =
    now.backfill !== start.backfill ||
    (now.backfill &&
      (now.until !== start.until ||
        now.backfillFiles.trim() !== start.backfillFiles ||
        now.backfillMb.trim() !== start.backfillMb));
  if (backfillMoved) change.backfill = value.backfill ?? null;
  return change;
}

/** Whom an app may act as: an owner or an adult who signs in. */
const actsAs = (m: Member) =>
  m.has_account && !m.is_deceased && (m.role === 'owner' || m.role === 'adult');

/** The kinds an app may be allowed: the household's, but notes and hidden ones (unless allowed already). */
const offeredKinds = (types: DocumentTypeView[], allowed: readonly string[]) =>
  types.filter((t) => t.key !== NOTE_KIND && (!t.hidden || allowed.includes(t.key)));

function AppFields(props: {
  id: string;
  form: AppForm;
  set: (f: AppForm) => void;
  types: DocumentTypeView[];
  ceilings: Ceilings;
  /** Connecting: whom it acts as, and its key, are asked too. */
  connect?: { people: Member[]; me: string };
  /** Whom it acts as, for "Only …": "you", or their name. */
  who: string;
}) {
  const { form, set, id } = props;
  const put = (more: Partial<AppForm>) => set({ ...form, ...more });
  const kinds = offeredKinds(props.types, form.kinds);
  const maxMb = Math.floor(props.ceilings.daily_bytes / MB);
  const days = backfillDays();
  return (
    <>
      <Field
        id={`${id}-name`}
        label="Name"
        value={form.name}
        maxLength={APP_NAME_MAX}
        required={false}
        requiredMark
        note="As the family sees it, beside what it sends."
        onChange={(v) => put({ name: v })}
      />
      {props.connect && (
        <>
          <div className="field">
            <label htmlFor={`${id}-who`}>Acting as</label>
            <select
              id={`${id}-who`}
              value={form.member}
              aria-describedby={`${id}-who-note`}
              onChange={(e) => put({ member: e.target.value })}
            >
              {props.connect.people.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === props.connect?.me
                    ? `${m.display_name} (you)`
                    : `${m.display_name} · ${m.role ? roleLabel(m.role) : ''}`}
                </option>
              ))}
            </select>
            <p id={`${id}-who-note`} className="muted field-note">
              What it sends goes into their Inbox. An owner or an adult who signs in. Somebody else
              turns it on themselves before it can send anything.
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-key`}>
              The app’s public key
              <span className="req-star" aria-hidden="true">
                {' '}
                *
              </span>{' '}
              <span className="req-word">required</span>
            </label>
            <textarea
              id={`${id}-key`}
              value={form.key}
              rows={3}
              maxLength={4096}
              spellCheck={false}
              autoCapitalize="off"
              aria-required="true"
              aria-describedby={`${id}-key-note`}
              onChange={(e) => put({ key: e.target.value })}
            />
            <p id={`${id}-key-note`} className="muted field-note">
              The app shows it: it starts “ed25519:”, or is a block that starts “-----BEGIN PUBLIC
              KEY-----”. It is not a secret.
            </p>
          </div>
        </>
      )}
      <fieldset className="limits-set">
        <legend className="field-label">Kinds it may send</legend>
        <p className="muted" id={`${id}-kinds-note`}>
          Anything it says is another kind is refused. Identity, legal and medical papers always
          wait for a look.
        </p>
        <div className="limits-list limits-kinds">
          {kinds.map((t) => (
            <Check
              key={t.key}
              id={`${id}-kind-${t.key}`}
              label={t.label}
              checked={form.kinds.includes(t.key)}
              onChange={(on) =>
                put({
                  kinds: on ? [...form.kinds, t.key] : form.kinds.filter((k) => k !== t.key),
                })
              }
            />
          ))}
        </div>
      </fieldset>
      <Select
        id={`${id}-seen`}
        label="Who sees what it sends"
        value={form.seen}
        options={(['', 'adults', 'household', 'private'] as const).map((v) => ({
          value: v,
          label: seenWords(v === '' ? null : v, props.who),
        }))}
        onChange={(v) => put({ seen: v as AppForm['seen'] })}
      />
      <fieldset className="limits-set">
        <legend className="field-label">The most it may send in a day</legend>
        <div className="row">
          <Field
            id={`${id}-files`}
            label="Files"
            value={form.files}
            inputMode="numeric"
            required={false}
            note={`Up to ${props.ceilings.daily_files}.`}
            onChange={(v) => put({ files: v })}
          />
          <Field
            id={`${id}-mb`}
            label="MB"
            value={form.mb}
            inputMode="numeric"
            required={false}
            note={`Up to ${maxMb}.`}
            onChange={(v) => put({ mb: v })}
          />
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-ip`}>Addresses it may send from</label>
        <textarea
          id={`${id}-ip`}
          value={form.ip}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby={`${id}-ip-note`}
          onChange={(e) => put({ ip: e.target.value })}
        />
        <p id={`${id}-ip-note`} className="muted field-note">
          {`One a line, up to ${APP_IP_ALLOW_MAX}: an address (203.0.113.7) or a network (203.0.113.0/24). Left empty, any address.`}
        </p>
      </div>
      <Check
        id={`${id}-backfill`}
        checked={form.backfill}
        label="Let it send older papers for a while"
        note={`More a day than usual, until a day within the next ${APP_BACKFILL_MAX_DAYS} days.`}
        onChange={(on) => put({ backfill: on, until: on && !form.until ? days.max : form.until })}
      />
      {form.backfill && (
        <fieldset className="limits-set">
          <legend className="field-label">Older papers</legend>
          <div className="field">
            <label htmlFor={`${id}-until`}>Until</label>
            <input
              id={`${id}-until`}
              type="date"
              value={form.until}
              min={days.min}
              max={days.max}
              onChange={(e) => put({ until: e.target.value })}
            />
          </div>
          <div className="row">
            <Field
              id={`${id}-bf-files`}
              label="Files a day"
              value={form.backfillFiles}
              inputMode="numeric"
              required={false}
              onChange={(v) => put({ backfillFiles: v })}
            />
            <Field
              id={`${id}-bf-mb`}
              label="MB a day"
              value={form.backfillMb}
              inputMode="numeric"
              required={false}
              onChange={(v) => put({ backfillMb: v })}
            />
          </div>
        </fieldset>
      )}
    </>
  );
}

// ------------------------------------------------------------- the screen

/** What was just made: the key the vault kept, and what to paste into the app. */
interface Made {
  app: ConnectedAppView;
  fingerprint: string;
  connection: string;
  /** A key added to an app already connected, rather than a new app. */
  keyAdded: boolean;
}

export function ConnectedAppsScreen() {
  const { authVersion, guarded, withToken, session } = useApp();
  const owner = storedRole() === 'owner';
  const {
    data,
    error: loadError,
    reload,
  } = useLoad(
    async (t) => {
      const [list, types, members] = await Promise.all([
        api.connectedApps.list(t),
        api.documentTypes(t, { all: true }).then((r) => r.items),
        owner ? api.members(t).then((r) => r.items) : Promise.resolve([] as Member[]),
      ]);
      return { list, types, members };
    },
    [authVersion, owner],
  );
  // The reader, whom a new app acts as unless another is chosen.
  const me = data?.members.find((m) => m.is_me)?.id ?? session.info?.member_id ?? '';
  const [connecting, setConnecting] = useState<AppForm | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ConnectedAppView | null>(null);
  const [retiring, setRetiring] = useState<{ app: ConnectedAppView; key: AppKeyView } | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const connectHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (said) statusLine.current?.focus();
  }, [said]);
  // The form's heading in focus as it opens, from the button that is gone.
  const open = connecting !== null;
  useEffect(() => {
    if (open) connectHeading.current?.focus();
  }, [open]);

  /** One action of a card's: said, the list asked again, a refusal said. */
  const act = async <T,>(
    run: () => Promise<T | null>,
    words: (done: T) => string,
  ): Promise<T | null> => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await run();
      if (done !== null) {
        setSaid(words(done));
        await reload();
      }
      return done;
    } catch (err) {
      setError(describeError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!connecting || !data || busy) return;
    const read = readForm(connecting, data.list.ceilings);
    if (!read.ok) return setError(read.error);
    if (!connecting.key.trim()) return setError('Paste the app’s public key.');
    const body: ConnectedAppInput = {
      ...read.value,
      member_id: connecting.member,
      public_key: connecting.key.trim(),
    };
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const app = await guarded((t) => api.connectedApps.create(t, body));
      if (app) {
        const key = app.keys[app.keys.length - 1];
        setMade({
          app,
          fingerprint: key?.fingerprint ?? '',
          connection: app.connection_string,
          keyAdded: false,
        });
        setConnecting(null);
        await reload();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const items = data?.list.items ?? [];
  const names = [...new Set(items.map((a) => a.name))];
  const people = (data?.members ?? []).filter(actsAs);
  return (
    <SettingsPage title="Connected apps">
      <p className="lede">
        {owner
          ? 'An app you connect sends documents into the Inbox of the person it acts as, signed with its own key. It can only send: it cannot open, list or download anything in the vault.'
          : 'An app an owner connects as you sends documents into your Inbox, signed with its own key. It can only send: it cannot open, list or download anything in the vault.'}
      </p>
      <p className="status-line" role="status" ref={statusLine} tabIndex={-1}>
        {said}
      </p>
      <ErrorNote message={error} />
      {data && !data.list.apps_public && items.length > 0 && (
        <p className="status status-warn" role="note">
          {appsNotPublicWords(names.length === 1 ? (names[0] ?? 'An app') : 'An app')}
        </p>
      )}
      {made && (
        <HandOver
          made={made}
          onDone={() => {
            setMade(null);
            connectButton.current?.focus();
          }}
        />
      )}
      {owner && data && !connecting && (
        <div className="row">
          <Button
            ref={connectButton}
            onClick={() => {
              setMade(null);
              setError(null);
              setSaid(null);
              setConnecting(blankForm(me));
            }}
          >
            Connect an app
          </Button>
        </div>
      )}
      {owner && data && connecting && (
        <section className="card stack" aria-labelledby="app-connect-h">
          <h2 id="app-connect-h" ref={connectHeading} tabIndex={-1} className="section-h">
            Connect an app
          </h2>
          <form className="stack" noValidate onSubmit={(e) => void connect(e)}>
            <AppFields
              id="app-new"
              form={connecting}
              set={setConnecting}
              types={data.types}
              ceilings={data.list.ceilings}
              connect={{ people, me }}
              who={
                connecting.member === me
                  ? 'you'
                  : (people.find((m) => m.id === connecting.member)?.display_name ?? 'them')
              }
            />
            <p className="muted">
              Connecting asks for your passkey, or a code from your authenticator app.
            </p>
            <div className="row">
              <Button type="submit" disabled={busy}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
              <Button
                kind="quiet"
                onClick={() => {
                  setConnecting(null);
                  setError(null);
                  requestAnimationFrame(() => connectButton.current?.focus());
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}
      {data === null && loadError ? (
        <LoadFailed message={loadError} what="connected apps" onRetry={() => void reload()} />
      ) : data ? (
        <section aria-labelledby="apps-h" className="stack">
          <h2 id="apps-h" className="section-h">
            {owner ? 'Apps connected' : 'Apps acting as you'}
          </h2>
          {items.length === 0 ? (
            <p className="muted">{owner ? 'No app is connected.' : 'No app acts as you.'}</p>
          ) : (
            items.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                owner={owner}
                busy={busy}
                types={data.types}
                ceilings={data.list.ceilings}
                onApprove={() =>
                  void act(
                    () => guarded((t) => api.connectedApps.approve(t, app.id)),
                    (a) => `${a.name} is on. What it sends arrives in your Inbox.`,
                  )
                }
                onPause={() =>
                  void act(
                    () => withToken((t) => api.connectedApps.pause(t, app.id)),
                    (a) =>
                      `${a.name} is paused. What it sends is refused until it is turned back on.`,
                  )
                }
                onResume={() =>
                  void act(
                    () => guarded((t) => api.connectedApps.resume(t, app.id)),
                    (a) =>
                      a.state === 'waiting_for_approval'
                        ? `${a.name} is no longer paused. It still waits for ${a.member_name} to turn it on.`
                        : `${a.name} is on again.`,
                  )
                }
                onChange={(change) =>
                  act(
                    () => guarded((t) => api.connectedApps.update(t, app.id, change)),
                    (a) => `Saved. ${a.name} may do what it now says here.`,
                  ).then((done) => done !== null)
                }
                onAddKey={async (key) => {
                  const added = await act(
                    () => guarded((t) => api.connectedApps.addKey(t, app.id, key)),
                    () => `The new key was added to ${app.name}.`,
                  );
                  if (added) {
                    setMade({
                      app,
                      fingerprint: added.key.fingerprint,
                      connection: added.connection_string,
                      keyAdded: true,
                    });
                  }
                  return added !== null;
                }}
                onRetire={(key) => setRetiring({ app, key })}
                onConfirmKey={(key) =>
                  void act(
                    () => guarded((t) => api.connectedApps.confirmKey(t, app.id, key.key_id)),
                    (a) =>
                      a.state === 'waiting_for_approval' && !a.mine
                        ? `The key is confirmed. ${a.name} waits for ${a.member_name} to turn it on again.`
                        : `The key is confirmed: ${a.name} may sign with it.`,
                  )
                }
                onRemove={() => setRemoving(app)}
              />
            ))
          )}
        </section>
      ) : null}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={connectButton}
          onConfirm={() =>
            void act(
              () =>
                withToken((t) => api.connectedApps.remove(t, removing.id)).then((r) =>
                  r === null ? null : true,
                ),
              () => `${removing.name} was removed. It can no longer send anything.`,
            ).finally(() => setRemoving(null))
          }
          onCancel={() => setRemoving(null)}
        >
          <p>
            {`It can no longer send anything, and its keys stop working. What it sent stays in ${
              removing.mine ? 'your' : `${removing.member_name}’s`
            } Inbox. To use it again, connect it again.`}
          </p>
        </ConfirmDialog>
      )}
      {retiring && (
        <ConfirmDialog
          title="Retire this key?"
          confirmLabel="Retire"
          busyLabel="Retiring…"
          danger
          busy={busy}
          returnFocus={connectButton}
          onConfirm={() =>
            void act(
              () =>
                withToken((t) =>
                  api.connectedApps.retireKey(t, retiring.app.id, retiring.key.key_id),
                ).then((r) => (r === null ? null : true)),
              () => `The key ${retiring.key.fingerprint} was retired.`,
            ).finally(() => setRetiring(null))
          }
          onCancel={() => setRetiring(null)}
        >
          <p>
            {`${retiring.app.name} can no longer sign with the key ${retiring.key.fingerprint}. Retire it once the app uses its new key.`}
          </p>
        </ConfirmDialog>
      )}
    </SettingsPage>
  );
}

/** The key the vault kept, to check, and what to paste into the app, with Copy. */
function HandOver(props: { made: Made; onDone: () => void }) {
  const { app, fingerprint, connection, keyAdded } = props.made;
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="card stack" aria-labelledby="app-made-h">
      <h2 id="app-made-h" ref={heading} tabIndex={-1} className="section-h">
        {keyAdded ? `${app.name}’s new key` : `${app.name} is connected`}
      </h2>
      {!keyAdded && (
        <p>
          {app.state === 'waiting_for_approval'
            ? `It does nothing until ${app.member_name} turns it on, in Settings → Connected apps.`
            : 'It is on.'}
        </p>
      )}
      <p>
        Check this matches what {app.name} shows:{' '}
        <code className="app-fingerprint">{fingerprint}</code>
      </p>
      <div className="field">
        <span className="field-label">Connection string</span>
        <code style={{ wordBreak: 'break-all' }}>{connection}</code>
        <span className="muted">Paste this into {app.name}. It holds no secret.</span>
      </div>
      <div className="row">
        <Button
          kind="quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(connection).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button onClick={props.onDone}>Done</Button>
      </div>
    </section>
  );
}

/** One app: what it is, what it may do, how its day is going, and what can be done about it. */
function AppCard(props: {
  app: ConnectedAppView;
  owner: boolean;
  busy: boolean;
  types: DocumentTypeView[];
  ceilings: Ceilings;
  onApprove: () => void;
  onPause: () => void;
  onResume: () => void;
  onChange: (change: ConnectedAppChange) => Promise<boolean>;
  onAddKey: (key: string) => Promise<boolean>;
  onRetire: (key: AppKeyView) => void;
  /** A key the app added itself, confirmed: an owner's, or its person's. */
  onConfirmKey: (key: AppKeyView) => void;
  onRemove: () => void;
}) {
  const { app, owner, busy } = props;
  const [changing, setChanging] = useState<{ start: AppForm; now: AppForm } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const h = `app-${app.id}-h`;
  const label = (key: string) => props.types.find((t) => t.key === key)?.label ?? key;
  const kinds = app.allowed_kinds.map(label);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changing || busy) return;
    const read = readForm(changing.now, props.ceilings);
    if (!read.ok) return setFormError(read.error);
    const change = changeOf(changing.start, changing.now, read.value);
    setFormError(null);
    if (Object.keys(change).length === 0) {
      setChanging(null);
      return;
    }
    if (await props.onChange(change)) setChanging(null);
  };

  const addKey = async (e: FormEvent) => {
    e.preventDefault();
    if (newKey === null || busy) return;
    if (!newKey.trim()) return setFormError('Paste the app’s new public key.');
    setFormError(null);
    if (await props.onAddKey(newKey.trim())) setNewKey(null);
  };

  return (
    <section className="card stack" aria-labelledby={h}>
      <div className="card-head">
        <h3 id={h} style={{ fontSize: 18, margin: 0 }}>
          {app.name}
        </h3>
        <span className={STATE_CLASS[app.state]}>{stateWords(app)}</span>
      </div>
      <p className="muted">{`Acting as ${whom(app)}`}</p>
      {changing ? (
        <form className="stack" noValidate onSubmit={(e) => void save(e)}>
          <AppFields
            id={`app-${app.id}`}
            form={changing.now}
            set={(now) => setChanging({ ...changing, now })}
            types={props.types}
            ceilings={props.ceilings}
            who={whom(app)}
          />
          <ErrorNote message={formError} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setChanging(null);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <dl className="facts">
          <dt>What it may do</dt>
          <dd>{app.scopes.map((s) => APP_SCOPE_WORDS[s]).join('. ')}</dd>
          <dt>Kinds it may send</dt>
          <dd>{kinds.length > 0 ? kinds.join(', ') : 'None yet'}</dd>
          <dt>Who sees what it sends</dt>
          <dd>{seenWords(app.default_visibility, whom(app))}</dd>
          <dt>Last used</dt>
          <dd>{app.last_used_at ? shortWhenWords(app.last_used_at) : 'Not yet'}</dd>
          <dt>Today</dt>
          <dd>{todayWords(app)}</dd>
          {app.counts && (
            <>
              <dt>What it sent you</dt>
              <dd>{`${app.counts.waiting} waiting in your Inbox, ${app.counts.filed} filed`}</dd>
            </>
          )}
          {app.refused_today > 0 && (
            <>
              <dt>Refused today</dt>
              <dd>
                {`${app.refused_today} ${app.refused_today === 1 ? 'request' : 'requests'}`}
                {app.last_refusal
                  ? `; the last: ${APP_REFUSAL_SHORT[app.last_refusal] ?? app.last_refusal}`
                  : ''}
              </dd>
            </>
          )}
          {app.backfill && (
            <>
              <dt>Older papers</dt>
              <dd>
                {`Until ${day(app.backfill.until)}: ${app.backfill.files_per_day} files and ${amountWords(app.backfill.bytes_per_day)} a day`}
              </dd>
            </>
          )}
          <dt>Addresses</dt>
          <dd>{app.ip_allow.length > 0 ? app.ip_allow.join(', ') : 'Any'}</dd>
        </dl>
      )}
      <div className="stack">
        <h4 className="field-label" id={`${h}-keys`}>
          {app.keys.length === 1 ? 'Its key' : 'Its keys'}
        </h4>
        <ul className="list" aria-labelledby={`${h}-keys`}>
          {app.keys.map((k) => (
            <li key={k.key_id}>
              <span>
                <code>{k.fingerprint}</code>
                <span className="muted">
                  {k.added_by === 'app' ? ' · added by the app' : ' · added by an owner'}
                  {k.retires_at ? ` · retires on ${day(k.retires_at)}` : ''}
                </span>
                {k.pending && (
                  <strong>
                    {' '}
                    · Not confirmed: it signs nothing until it is. Confirm it only if {
                      app.name
                    }{' '}
                    shows this same key.
                  </strong>
                )}
              </span>
              {k.pending && (owner || app.mine) && (
                <Button
                  kind="quiet"
                  disabled={busy}
                  ariaLabel={`Confirm the key ${k.fingerprint}`}
                  onClick={() => props.onConfirmKey(k)}
                >
                  Confirm
                </Button>
              )}
              {owner && app.keys.length > 1 && (
                <Button
                  kind="quiet"
                  danger
                  disabled={busy}
                  ariaLabel={`Retire the key ${k.fingerprint}`}
                  onClick={() => props.onRetire(k)}
                >
                  Retire
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {owner && app.connection_string && !changing && (
        <details>
          <summary>{`What to paste into ${app.name}`}</summary>
          <div className="stack">
            <code style={{ wordBreak: 'break-all' }}>{app.connection_string}</code>
            <span className="muted">It holds no secret.</span>
            <div className="row">
              <Button
                kind="quiet"
                ariaLabel={`Copy what to paste into ${app.name}`}
                onClick={() => {
                  void navigator.clipboard?.writeText(app.connection_string).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </details>
      )}
      {newKey !== null && (
        <form className="stack" noValidate onSubmit={(e) => void addKey(e)}>
          <div className="field">
            <label htmlFor={`app-${app.id}-newkey`}>{`${app.name}’s new public key`}</label>
            <textarea
              id={`app-${app.id}-newkey`}
              value={newKey}
              rows={3}
              maxLength={4096}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setNewKey(e.target.value)}
            />
            <p className="muted field-note">
              Two keys at most. Once the app signs with the new one, the older retires by itself
              after a week; or retire it here.
            </p>
          </div>
          <ErrorNote message={formError} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add the key'}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setNewKey(null);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!changing && newKey === null && (
        <div className="row">
          {app.mine && app.state === 'waiting_for_approval' && (
            <Button disabled={busy} ariaLabel={`Turn on ${app.name}`} onClick={props.onApprove}>
              Turn on
            </Button>
          )}
          {owner && app.state === 'active' && (
            <Button
              kind="quiet"
              disabled={busy}
              ariaLabel={`Pause ${app.name}`}
              onClick={props.onPause}
            >
              Pause
            </Button>
          )}
          {owner && app.state === 'paused' && (
            <Button
              kind="quiet"
              disabled={busy}
              ariaLabel={`Turn ${app.name} back on`}
              onClick={props.onResume}
            >
              Turn back on
            </Button>
          )}
          {owner && (
            <Button
              kind="quiet"
              disabled={busy}
              ariaLabel={`Change ${app.name}`}
              onClick={() => {
                const start = formOf(app);
                setFormError(null);
                setChanging({ start, now: start });
              }}
            >
              Change
            </Button>
          )}
          {owner && (
            <Button
              kind="quiet"
              disabled={busy || app.keys.length >= 2}
              ariaLabel={`Add a key to ${app.name}`}
              onClick={() => {
                setFormError(null);
                setNewKey('');
              }}
            >
              Add a key
            </Button>
          )}
          {(owner || app.mine) && (
            <Button
              kind="quiet"
              danger
              disabled={busy}
              ariaLabel={`Remove ${app.name}`}
              onClick={props.onRemove}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
