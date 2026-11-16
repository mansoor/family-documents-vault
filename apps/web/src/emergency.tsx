import {
  BLOOD_TYPES,
  EMERGENCY_AUDIENCE_LABELS,
  EMERGENCY_AUDIENCES,
  EMERGENCY_DOCUMENT_KINDS,
  EMERGENCY_DOCUMENT_LABELS,
  EMERGENCY_FIELD_KEYS,
  EMERGENCY_FIELD_LABELS,
  EMERGENCY_LINK_DEFAULT_HOURS,
  EMERGENCY_LINK_MAX_HOURS,
  EMERGENCY_NOT_ADVICE,
  emergencyFieldsFor,
  emergencyFilled,
  WALLET_CARD_DEFAULT,
  type BloodType,
  type CreatedShare,
  type EmergencyAudience,
  type EmergencyFieldKey,
  type EmergencyFields,
  type EmergencyItem,
  type EmergencyLink,
  type EmergencyMedication,
  type EmergencyPerson,
  type EmergencyView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError, type Member } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateOnlyWords, dateTimeWords } from './family-time.js';
import { EmailTheLink } from './screens/Share.js';
import { ChangeLink } from './screens/ChangeLink.js';
import {
  Button,
  Check,
  ConfirmDialog,
  ErrorNote,
  Field,
  LoadFailed,
  OnTop,
  Select,
  Sheet,
  Switch,
  TextArea,
} from './ui.js';

/**
 * A person's emergency information (0.9.0, H4 of the health plan;
 * `features.emergency_info`), on their page:
 *
 *  - the page itself — allergies, medications, conditions, blood type,
 *    insurance, doctors and emergency contacts, and their advance
 *    directive, healthcare proxy and insurance card as documents — and its
 *    editor, for the person and the owners;
 *  - who can see it, for the person (an owner, for a child);
 *  - a wallet card to print, with the person ticking what goes on it;
 *  - a clinician's link that lasts hours, and every time it was opened.
 *
 * It files what was typed and shows it back. It reads nothing, checks
 * nothing and suggests nothing: not a medical tool.
 */

/** Who sees a page, said about this person. */
function audienceWords(view: EmergencyView, mine: boolean, name: string): string {
  const whose = mine ? 'You' : name;
  const named = view.chosen.length ? `, and ${view.chosen.map((c) => c.name).join(', ')}` : '';
  switch (view.audience) {
    case 'owners_and_self':
      return `${whose} and the owners${named}.`;
    case 'adults':
      return `${whose}, the owners and every adult${named}.`;
    case 'family':
      return `Everyone in the family${named}.`;
  }
}

/** A list's entries, one line each: what was typed, and nothing read into it. */
function itemLine(i: EmergencyItem | EmergencyMedication | EmergencyPerson): string {
  const parts = [i.name];
  if ('dose' in i && i.dose) parts.push(i.dose);
  if ('role' in i && i.role) parts.push(i.role);
  if ('phone' in i && i.phone) parts.push(i.phone);
  if (i.note) parts.push(i.note);
  return parts.join(' · ');
}

/**
 * The parts of a page, as typed, in the page's order: for the person's
 * page, a wallet card and a clinician's link alike. `keys` says which; the
 * date of birth is the family's own detail.
 */
export function EmergencyDetails(props: {
  fields: EmergencyFields;
  keys: readonly EmergencyFieldKey[];
  dateOfBirth: string | null;
  /** Say a part ticked but empty ("Nothing entered"), as a clinician's link does. */
  showEmpty?: boolean;
}) {
  const f = props.fields;
  const rows: Array<{ key: EmergencyFieldKey; body: ReactNode }> = [];
  for (const key of EMERGENCY_FIELD_KEYS) {
    if (!props.keys.includes(key)) continue;
    let body: ReactNode = null;
    if (key === 'date_of_birth' && props.dateOfBirth) body = dateOnlyWords(props.dateOfBirth);
    if (key === 'blood_type' && f.blood_type) body = f.blood_type;
    if (key === 'notes' && f.notes) body = <span className="emergency-notes">{f.notes}</span>;
    if (key === 'insurance' && f.insurance) {
      const ins = f.insurance;
      const lines = [
        ins.insurer,
        ins.member_id ? `Member ID ${ins.member_id}` : null,
        ins.group_number ? `Group ${ins.group_number}` : null,
        ins.phone,
      ].filter((x): x is string => Boolean(x));
      if (lines.length) body = lines.join(' · ');
    }
    if (
      key === 'allergies' ||
      key === 'medications' ||
      key === 'conditions' ||
      key === 'doctors' ||
      key === 'emergency_contacts'
    ) {
      const list = (f[key] ?? []) as Array<EmergencyItem | EmergencyMedication | EmergencyPerson>;
      if (list.length) {
        body = (
          <ul className="emergency-list">
            {list.map((i) => (
              <li key={i.id}>{itemLine(i)}</li>
            ))}
          </ul>
        );
      }
    }
    if (body === null && !props.showEmpty) continue;
    rows.push({ key, body: body ?? <span className="muted">Nothing entered</span> });
  }
  if (rows.length === 0) return <p className="muted">Nothing entered yet.</p>;
  return (
    <dl className="emergency-details">
      {rows.map((r) => (
        <div key={r.key} className="emergency-row">
          <dt>{EMERGENCY_FIELD_LABELS[r.key]}</dt>
          <dd>{r.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Emergency information" on a person's page: for the person, the owners,
 * whoever its audience takes in, and a live caregiver. Nothing for anybody
 * else — the vault answers them as if there were none, and nothing is drawn.
 */
export function EmergencyCard(props: { member: Member; name: string }) {
  const { authVersion, caps } = useApp();
  const offered = caps?.features.emergency_info === true && props.member.kind !== 'guest';
  const { data, error, reload } = useLoad(
    async (t) => {
      if (!offered) return null;
      return api.emergencyOf(t, props.member.id).catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      });
    },
    [authVersion, props.member.id, offered],
  );
  const [mode, setMode] = useState<'view' | 'edit' | 'audience'>('view');
  const [sheet, setSheet] = useState<'card' | 'share' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Where each sheet gives the focus back: the button that opened it.
  const cardOpener = useRef<HTMLButtonElement>(null);
  const shareOpener = useRef<HTMLButtonElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  if (!offered) return null;
  if (data === null && error) {
    return (
      <LoadFailed message={error} what="the emergency information" onRetry={() => void reload()} />
    );
  }
  if (!data) return null;
  const view = data;
  const mine = props.member.is_me;
  const filled = emergencyFilled(view.fields, view.date_of_birth);
  const typed = filled.filter((k) => k !== 'date_of_birth');
  const documents = EMERGENCY_DOCUMENT_KINDS.filter((k) => view.documents[k].length > 0);
  const done = async (words: string) => {
    setMode('view');
    await reload();
    setSaid(words);
  };

  return (
    <section aria-labelledby="emergency-h" className="stack emergency">
      <h2 id="emergency-h" className="section-h">
        Emergency information
      </h2>
      {view.caregiver && <p className="muted">You see this as {props.name}’s caregiver.</p>}
      {mode === 'edit' ? (
        <EmergencyEditor
          view={view}
          name={props.name}
          mine={mine}
          onCancel={() => setMode('view')}
          onSaved={() => void done('Saved.')}
          onStale={() => void reload()}
        />
      ) : mode === 'audience' ? (
        <EmergencyAudienceForm
          view={view}
          name={props.name}
          mine={mine}
          onCancel={() => setMode('view')}
          onSaved={() => void done('Who can see it is saved.')}
        />
      ) : (
        <>
          {typed.length === 0 ? (
            <p className="muted">
              {view.can_edit
                ? mine
                  ? 'Nothing here yet. Add your allergies, medications, conditions, blood type, insurance, doctors and who to call, so the people you choose can find them quickly.'
                  : `Nothing here yet. Add ${props.name}’s allergies, medications, conditions and who to call.`
                : 'Nothing entered yet.'}
            </p>
          ) : (
            <EmergencyDetails fields={view.fields} keys={filled} dateOfBirth={view.date_of_birth} />
          )}
          {documents.length > 0 && (
            <ul className="list" aria-label="Papers">
              {documents.flatMap((k) =>
                view.documents[k].map((d) => (
                  <li key={d.id}>
                    <span>
                      <span className="muted">{EMERGENCY_DOCUMENT_LABELS[k]}</span>{' '}
                      <Link to={`/documents/${d.id}`}>{d.title}</Link>
                    </span>
                  </li>
                )),
              )}
            </ul>
          )}
          <p className="muted emergency-who">
            Who can see it: {audienceWords(view, mine, props.name)}
          </p>
          <p className="muted">{EMERGENCY_NOT_ADVICE}</p>
          <div className="row emergency-actions">
            {view.can_edit && (
              <Button kind="quiet" onClick={() => setMode('edit')}>
                {typed.length ? 'Edit' : 'Add emergency information'}
              </Button>
            )}
            {view.can_choose && (
              <Button kind="quiet" onClick={() => setMode('audience')}>
                Who can see it
              </Button>
            )}
            {typed.length > 0 && (
              <Button kind="quiet" ref={cardOpener} onClick={() => setSheet('card')}>
                Print a wallet card
              </Button>
            )}
            {view.can_choose && typed.length > 0 && (
              <Button kind="quiet" ref={shareOpener} onClick={() => setSheet('share')}>
                Share with a clinician
              </Button>
            )}
          </div>
        </>
      )}
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {view.can_see_links && (
        <ClinicianLinks memberId={props.member.id} name={props.name} mine={mine} key={said ?? ''} />
      )}
      {sheet === 'card' && (
        <WalletCard
          view={view}
          name={props.member.display_name}
          returnFocus={cardOpener}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'share' && (
        <ClinicianShare
          view={view}
          name={props.name}
          mine={mine}
          returnFocus={shareOpener}
          onClose={() => {
            setSheet(null);
            setSaid(null);
          }}
          onMade={() => setSaid('The link is made.')}
        />
      )}
    </section>
  );
}

/** A new entry's id: letters and digits, as the vault asks. */
let entries = 0;
const entryId = () => `e${Date.now().toString(36)}${(entries++).toString(36)}`;

type ListKey = 'allergies' | 'medications' | 'conditions' | 'doctors' | 'emergency_contacts';

/** What each list asks of an entry, besides its name. */
const LIST_PARTS: Record<
  ListKey,
  { one: string; more: Array<'dose' | 'role' | 'phone' | 'note'> }
> = {
  allergies: { one: 'Allergy', more: ['note'] },
  medications: { one: 'Medication', more: ['dose', 'note'] },
  conditions: { one: 'Condition', more: ['note'] },
  doctors: { one: 'Doctor', more: ['role', 'phone', 'note'] },
  emergency_contacts: { one: 'Who to call', more: ['role', 'phone', 'note'] },
};

const PART_LABELS: Record<'dose' | 'role' | 'phone' | 'note', Record<ListKey, string>> = {
  dose: {
    allergies: 'Dose',
    medications: 'Dose, as written',
    conditions: 'Dose',
    doctors: 'Dose',
    emergency_contacts: 'Dose',
  },
  role: {
    allergies: 'Role',
    medications: 'Role',
    conditions: 'Role',
    doctors: 'Practice or specialty',
    emergency_contacts: 'Who they are',
  },
  phone: {
    allergies: 'Phone',
    medications: 'Phone',
    conditions: 'Phone',
    doctors: 'Phone',
    emergency_contacts: 'Phone',
  },
  note: {
    allergies: 'Note (reaction, severity)',
    medications: 'Note',
    conditions: 'Note',
    doctors: 'Note',
    emergency_contacts: 'Note',
  },
};

type Entry = {
  id: string;
  name: string;
  dose?: string;
  role?: string;
  phone?: string;
  note?: string;
};

/** The page's lists as the form keeps them: every part a string. */
function asEntries(list: Array<Record<string, unknown>> | undefined): Entry[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return (list ?? []).map((e) => ({
    id: str(e.id),
    name: str(e.name),
    dose: str(e.dose),
    role: str(e.role),
    phone: str(e.phone),
    note: str(e.note),
  }));
}

/** An entry as the vault takes it: blanks left out. */
function fromEntry(e: Entry, parts: ReadonlyArray<'dose' | 'role' | 'phone' | 'note'>) {
  const out: Record<string, string> = { id: e.id, name: e.name.trim() };
  for (const p of parts) {
    const v = (e[p] ?? '').trim();
    if (v) out[p] = v;
  }
  return out;
}

function EmergencyEditor(props: {
  view: EmergencyView;
  name: string;
  mine: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const { withToken } = useApp();
  const f = props.view.fields;
  const [blood, setBlood] = useState<string>(f.blood_type ?? '');
  const [lists, setLists] = useState<Record<ListKey, Entry[]>>({
    allergies: asEntries(f.allergies as Array<Record<string, unknown>> | undefined),
    medications: asEntries(f.medications as Array<Record<string, unknown>> | undefined),
    conditions: asEntries(f.conditions as Array<Record<string, unknown>> | undefined),
    doctors: asEntries(f.doctors as Array<Record<string, unknown>> | undefined),
    emergency_contacts: asEntries(
      f.emergency_contacts as Array<Record<string, unknown>> | undefined,
    ),
  });
  const [insurer, setInsurer] = useState(f.insurance?.insurer ?? '');
  const [memberId, setMemberId] = useState(f.insurance?.member_id ?? '');
  const [group, setGroup] = useState(f.insurance?.group_number ?? '');
  const [insPhone, setInsPhone] = useState(f.insurance?.phone ?? '');
  const [notes, setNotes] = useState(f.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const change = (key: ListKey, id: string, part: keyof Entry, value: string) =>
    setLists((l) => ({
      ...l,
      [key]: l[key].map((e) => (e.id === id ? { ...e, [part]: value } : e)),
    }));
  const add = (key: ListKey) =>
    setLists((l) => ({ ...l, [key]: [...l[key], { id: entryId(), name: '' }] }));
  const remove = (key: ListKey, id: string) =>
    setLists((l) => ({ ...l, [key]: l[key].filter((e) => e.id !== id) }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const fields: EmergencyFields = {
      blood_type: blood ? (blood as BloodType) : null,
      notes: notes.trim() || null,
      insurance:
        insurer.trim() || memberId.trim() || group.trim() || insPhone.trim()
          ? {
              insurer: insurer.trim() || null,
              member_id: memberId.trim() || null,
              group_number: group.trim() || null,
              phone: insPhone.trim() || null,
            }
          : null,
    };
    for (const key of Object.keys(LIST_PARTS) as ListKey[]) {
      const kept = lists[key].filter((x) => x.name.trim());
      (fields as Record<string, unknown>)[key] = kept.map((x) =>
        fromEntry(x, LIST_PARTS[key].more),
      );
    }
    setBusy(true);
    try {
      await withToken((t) =>
        api.saveEmergency(t, props.view.member_id, fields, props.view.version),
      );
      props.onSaved();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'conflict') {
        setProblem(
          'Someone else changed this while you were editing. It has been reloaded: check it, and make your change again.',
        );
        props.onStale();
      } else {
        setProblem(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack emergency-form" onSubmit={(e) => void save(e)} noValidate>
      <p className="muted">
        {props.mine ? 'Type it as you would say it.' : `Type it as ${props.name} would say it.`}{' '}
        {EMERGENCY_NOT_ADVICE}
      </p>
      <Select
        id="emergency-blood"
        label="Blood type"
        value={blood}
        options={[
          { value: '', label: 'Not known' },
          ...BLOOD_TYPES.map((b) => ({ value: b, label: b })),
        ]}
        onChange={setBlood}
      />
      {(Object.keys(LIST_PARTS) as ListKey[]).map((key) => (
        <fieldset key={key} className="emergency-list-edit">
          <legend>{EMERGENCY_FIELD_LABELS[key]}</legend>
          {lists[key].map((entry, n) => (
            <div key={entry.id} className="emergency-entry">
              <Field
                id={`emergency-${key}-${entry.id}-name`}
                label={`${LIST_PARTS[key].one} ${n + 1}`}
                value={entry.name}
                required={false}
                maxLength={120}
                onChange={(v) => change(key, entry.id, 'name', v)}
              />
              {LIST_PARTS[key].more.map((part) => (
                <Field
                  key={part}
                  id={`emergency-${key}-${entry.id}-${part}`}
                  label={PART_LABELS[part][key]}
                  value={entry[part] ?? ''}
                  required={false}
                  maxLength={part === 'note' ? 300 : part === 'phone' ? 40 : 120}
                  onChange={(v) => change(key, entry.id, part, v)}
                />
              ))}
              <Button
                kind="quiet"
                danger
                ariaLabel={`Remove ${LIST_PARTS[key].one.toLowerCase()} ${n + 1}`}
                onClick={() => remove(key, entry.id)}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button kind="quiet" onClick={() => add(key)}>
            Add {LIST_PARTS[key].one.toLowerCase()}
          </Button>
        </fieldset>
      ))}
      <fieldset className="emergency-list-edit">
        <legend>Insurance</legend>
        <Field
          id="emergency-insurer"
          label="Insurer"
          value={insurer}
          required={false}
          maxLength={120}
          onChange={setInsurer}
        />
        <Field
          id="emergency-member-id"
          label="Member ID"
          value={memberId}
          required={false}
          maxLength={60}
          onChange={setMemberId}
        />
        <Field
          id="emergency-group"
          label="Group number"
          value={group}
          required={false}
          maxLength={60}
          onChange={setGroup}
        />
        <Field
          id="emergency-ins-phone"
          label="Insurer’s phone"
          value={insPhone}
          required={false}
          maxLength={40}
          onChange={setInsPhone}
        />
        <p className="muted">The card itself is a document: file it as an Insurance card.</p>
      </fieldset>
      <TextArea
        id="emergency-notes"
        label="Other information"
        value={notes}
        maxLength={2000}
        hint="Anything else someone helping should know, in your own words."
        onChange={setNotes}
      />
      <ErrorNote message={problem} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EmergencyAudienceForm(props: {
  view: EmergencyView;
  name: string;
  mine: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { withToken } = useApp();
  const [audience, setAudience] = useState<EmergencyAudience>(props.view.audience);
  const [chosen, setChosen] = useState<string[]>(props.view.chosen.map((c) => c.member_id));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const candidates = props.view.candidates ?? [];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await withToken((t) =>
        api.setEmergencyAudience(t, props.view.member_id, {
          audience,
          chosen_member_ids: chosen,
        }),
      );
      props.onSaved();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={(e) => void save(e)} noValidate>
      <fieldset className="emergency-list-edit">
        <legend>
          {props.mine
            ? 'Who can see your emergency information'
            : `Who can see ${props.name}’s emergency information`}
        </legend>
        <p className="muted">
          {props.mine ? 'You' : props.name} and the owners always can, and so can a caregiver{' '}
          {props.mine ? 'you keep' : 'they keep'}.
        </p>
        {EMERGENCY_AUDIENCES.map((a) => (
          <div key={a} className="check">
            <input
              id={`emergency-audience-${a}`}
              type="radio"
              name="emergency-audience"
              checked={audience === a}
              onChange={() => setAudience(a)}
            />
            <label htmlFor={`emergency-audience-${a}`}>{EMERGENCY_AUDIENCE_LABELS[a]}</label>
          </div>
        ))}
      </fieldset>
      {candidates.length > 0 && (
        <fieldset className="emergency-list-edit">
          <legend>And these people too</legend>
          {candidates.map((c) => (
            <Check
              key={c.member_id}
              id={`emergency-chosen-${c.member_id}`}
              checked={chosen.includes(c.member_id)}
              label={c.name}
              onChange={(on) =>
                setChosen((now) =>
                  on ? [...now, c.member_id] : now.filter((x) => x !== c.member_id),
                )
              }
            />
          ))}
        </fieldset>
      )}
      <ErrorNote message={problem} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * A wallet card to print (H4): the parts the person ticks, on a card the
 * size of a bank card, with nothing on it that needs the vault — no link,
 * no code. Printed on paper, light whatever the app's theme.
 */
function WalletCard(props: {
  view: EmergencyView;
  name: string;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const filled = emergencyFilled(props.view.fields, props.view.date_of_birth);
  const [ticked, setTicked] = useState<EmergencyFieldKey[]>(() =>
    filled.filter((k) => WALLET_CARD_DEFAULT.includes(k)),
  );
  const print = () => {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    document.body.classList.add('printing-wallet-card');
    // Put back once the printer has the card: when the browser says it has
    // printed, or leaves print. A phone's browser returns from print() at
    // once and prints later (the H4 review), so nothing is put back before
    // then — but for a browser that says neither, a minute later.
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    let done = false;
    const after = () => {
      if (done) return;
      done = true;
      document.body.classList.remove('printing-wallet-card');
      if (theme) root.setAttribute('data-theme', theme);
      window.removeEventListener('afterprint', after);
      media?.removeEventListener('change', left);
      window.clearTimeout(fallback);
    };
    const left = (e: MediaQueryListEvent) => {
      if (!e.matches) after();
    };
    window.addEventListener('afterprint', after);
    media?.addEventListener('change', left);
    const fallback = window.setTimeout(after, 60_000);
    window.print();
  };
  const card = (
    <div className="wallet-card" aria-label={`Wallet card for ${props.name}`}>
      <p className="wallet-card-title">
        <strong>Emergency information</strong> — {props.name}
      </p>
      <EmergencyDetails
        fields={emergencyFieldsFor(props.view.fields, ticked)}
        keys={ticked}
        dateOfBirth={ticked.includes('date_of_birth') ? props.view.date_of_birth : null}
      />
      <p className="wallet-card-foot">{EMERGENCY_NOT_ADVICE}</p>
    </div>
  );
  return (
    <>
      <Sheet
        label="Print a wallet card"
        busy={false}
        returnFocus={props.returnFocus}
        onClose={props.onClose}
      >
        <h2 className="section-h">Print a wallet card</h2>
        <p className="muted">
          Tick what goes on it. It needs nothing but the paper: no link, and no code to scan.
        </p>
        <fieldset className="emergency-list-edit">
          <legend>On the card</legend>
          {filled.map((k) => (
            <Check
              key={k}
              id={`wallet-${k}`}
              checked={ticked.includes(k)}
              label={EMERGENCY_FIELD_LABELS[k]}
              onChange={(on) =>
                setTicked((now) =>
                  EMERGENCY_FIELD_KEYS.filter((x) => (x === k ? on : now.includes(x))),
                )
              }
            />
          ))}
        </fieldset>
        <div className="wallet-card-preview">{card}</div>
        <div className="row">
          <Button kind="primary" disabled={ticked.length === 0} onClick={print}>
            Print
          </Button>
          <Button kind="quiet" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </Sheet>
      {/* What the printer is given: the card alone (styles.css, @media print). */}
      <OnTop>
        <div className="wallet-print-root" aria-hidden="true">
          {card}
        </div>
      </OnTop>
    </>
  );
}

const HOURS = [1, 2, 4, 8, 12, 24].filter((h) => h <= EMERGENCY_LINK_MAX_HOURS);

/**
 * "Share with a clinician" (H4): a link to view the parts ticked, for
 * hours, with a PIN or a password if wanted; whoever opens it, and when,
 * is written down for the person. A share link like any other, emailed the
 * same way, and taken back the same way.
 */
function ClinicianShare(props: {
  view: EmergencyView;
  name: string;
  mine: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onMade: () => void;
}) {
  const { guarded } = useApp();
  const filled = emergencyFilled(props.view.fields, props.view.date_of_birth);
  const [ticked, setTicked] = useState<EmergencyFieldKey[]>(filled);
  const [hours, setHours] = useState(String(EMERGENCY_LINK_DEFAULT_HOURS));
  const [lock, setLock] = useState<'none' | 'pin' | 'password'>('pin');
  const [label, setLabel] = useState('');
  const [showName, setShowName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<CreatedShare | null>(null);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    if (ticked.length === 0) {
      setProblem('Tick at least one part to show.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const created = await guarded((t) =>
        api.makeEmergencyLink(t, props.view.member_id, {
          fields: ticked,
          expires_in_hours: Number(hours),
          ...(lock === 'pin'
            ? { with_pin: true }
            : lock === 'password'
              ? { with_password: true }
              : {}),
          ...(label.trim() ? { recipient_label: label.trim() } : {}),
          ...(showName ? { show_title: true } : {}),
        }),
      );
      if (created) {
        setMade(created);
        props.onMade();
      }
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const link = made ? (made.link_url ?? `${window.location.origin}/s#${made.link_token}`) : '';
  return (
    <Sheet
      label="Share with a clinician"
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
    >
      <h2 className="section-h">Share with a clinician</h2>
      {made ? (
        <div className="stack">
          <p>
            Send this to whoever needs it. It works for {hours} hour{hours === '1' ? '' : 's'}, to
            look at only, and {props.mine ? 'you' : 'the owners'} can see each time it is opened.
          </p>
          <code className="emergency-link">{link}</code>
          <Button kind="quiet" onClick={() => void navigator.clipboard?.writeText(link)}>
            Copy the link
          </Button>
          <EmailTheLink share={made.share} idPrefix="emergency" />
          {made.pin && (
            <div className="field">
              <span className="field-label">The PIN</span>
              <code className="emergency-secret">{made.pin}</code>
              <span className="muted">Tell them this some other way, not in the same message.</span>
            </div>
          )}
          {made.password && (
            <div className="field">
              <span className="field-label">The password</span>
              <code className="emergency-secret">{made.password}</code>
              <span className="muted">Tell them this some other way, not in the same message.</span>
            </div>
          )}
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => void make(e)} noValidate>
          <p className="muted">
            A link to look at what you tick, and nothing else — no documents. It stops working on
            its own after the hours you choose, and nobody can find it by searching.
          </p>
          <fieldset className="emergency-list-edit">
            <legend>What it shows</legend>
            {filled.map((k) => (
              <Check
                key={k}
                id={`clinician-${k}`}
                checked={ticked.includes(k)}
                label={EMERGENCY_FIELD_LABELS[k]}
                onChange={(on) =>
                  setTicked((now) =>
                    EMERGENCY_FIELD_KEYS.filter((x) => (x === k ? on : now.includes(x))),
                  )
                }
              />
            ))}
          </fieldset>
          <Select
            id="clinician-hours"
            label="It works for"
            value={hours}
            options={HOURS.map((h) => ({
              value: String(h),
              label: `${h} hour${h === 1 ? '' : 's'}`,
            }))}
            onChange={setHours}
          />
          <Select
            id="clinician-lock"
            label="To open it, they also need"
            value={lock}
            options={[
              { value: 'pin', label: 'A PIN you tell them' },
              { value: 'password', label: 'A password you tell them' },
              { value: 'none', label: 'Nothing else' },
            ]}
            onChange={(v) => setLock(v as 'none' | 'pin' | 'password')}
          />
          <Field
            id="clinician-label"
            label="Who it is for (only you see this)"
            value={label}
            required={false}
            maxLength={80}
            placeholder="Dr Patel, St Mary’s A&E"
            onChange={setLabel}
          />
          <Switch
            id="clinician-name"
            label={`Say whose it is before it is opened`}
            checked={showName}
            onChange={setShowName}
          />
          <p className="muted" id="clinician-name-note">
            {showName
              ? `The page they see first names ${props.mine ? 'you' : props.name}${props.mine ? ', as the one who sent it' : ''}.`
              : props.mine
                ? 'Off, the page they see first says only that some information was shared: not whose it is, and not who sent it. Your name shows once it is opened.'
                : `Off, the page they see first doesn’t say whose it is, only that you sent it. ${props.name}’s name shows once it is opened.`}{' '}
            With a PIN or a password, that page says neither in any case.
          </p>
          <ErrorNote message={problem} />
          <div className="row">
            <Button kind="primary" type="submit" disabled={busy}>
              {busy ? 'Making…' : 'Make the link'}
            </Button>
            <Button kind="quiet" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

/** A browser, in a few words, from what it said it was. */
function browserWords(agent: string | null): string {
  if (!agent) return 'a browser';
  const known = /(Edg|Firefox|Chrome|Safari)\/[\d.]+/.exec(agent);
  return known ? (known[1] === 'Edg' ? 'Edge' : (known[1] as string)) : agent.slice(0, 60);
}

/**
 * The person's clinician's links, newest first, and each time each was
 * opened — when, from what network and browser: for the person and the
 * owners. Taken back here.
 */
function ClinicianLinks(props: { memberId: string; name: string; mine: boolean }) {
  const { authVersion, withToken } = useApp();
  const { data, reload } = useLoad(
    (t) => api.emergencyLinks(t, props.memberId).catch(() => ({ items: [] as EmergencyLink[] })),
    [authVersion, props.memberId],
  );
  const [ending, setEnding] = useState<EmergencyLink | null>(null);
  // A link changed (0.9.0, LK), by whoever made it: its form, filled in.
  const [changing, setChanging] = useState<EmergencyLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const changeOpener = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="clinician-links-h" className="stack">
      <h3 id="clinician-links-h" className="section-h">
        Links for clinicians
      </h3>
      <ul className="list">
        {items.map((l) => (
          <li key={l.id} className="emergency-link-row">
            <span>
              <strong>{l.recipient_label ?? 'A link'}</strong>
              <span className="muted">
                {l.state === 'active'
                  ? `Works until ${dateTimeWords(l.expires_at)}`
                  : l.state === 'revoked'
                    ? 'Taken back'
                    : l.state === 'locked'
                      ? 'Stopped: what it asks for was wrong too many times'
                      : 'Ended'}{' '}
                · Shows{' '}
                {l.emergency_fields.map((k) => EMERGENCY_FIELD_LABELS[k].toLowerCase()).join(', ')}
              </span>
              {l.openings.length === 0 ? (
                <span className="muted">Not opened.</span>
              ) : (
                <ul className="emergency-openings" aria-label="When it was opened">
                  {l.openings.map((o, i) => (
                    <li key={`${o.at}-${i}`}>
                      Opened {dateTimeWords(o.at)} from {browserWords(o.user_agent)}
                      {o.network ? ` on the network ${o.network}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </span>
            {l.state === 'active' && (
              <span className="row" style={{ gap: 8 }}>
                {l.changeable === true && (
                  <Button
                    kind="quiet"
                    disabled={busy}
                    ariaLabel={`Change the link${l.recipient_label ? ` for ${l.recipient_label}` : ''}`}
                    onClick={() => {
                      changeOpener.current = document.activeElement as HTMLElement | null;
                      setChanging(l);
                    }}
                  >
                    Change
                  </Button>
                )}
                <Button
                  kind="quiet"
                  danger
                  disabled={busy}
                  ariaLabel={`Take back the link${l.recipient_label ? ` for ${l.recipient_label}` : ''}`}
                  onClick={() => setEnding(l)}
                >
                  Take back
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <ErrorNote message={problem} />
      <p className="notice status-line" role="status">
        {said}
      </p>
      {changing && (
        <Sheet
          label="Change the link for a clinician"
          busy={saving}
          returnFocus={changeOpener}
          onClose={() => setChanging(null)}
        >
          <ChangeLink
            link={changing}
            target={`${props.name}’s emergency information`}
            onBusy={setSaving}
            onCancel={() => setChanging(null)}
            onDone={(words) => {
              setChanging(null);
              setSaid(words);
              void reload();
            }}
          />
        </Sheet>
      )}
      {ending && (
        <ConfirmDialog
          title="Take back this link?"
          confirmLabel="Take back"
          busyLabel="Taking back…"
          danger
          busy={busy}
          onConfirm={() => {
            const l = ending;
            setBusy(true);
            setProblem(null);
            void withToken((t) => api.revokeEmergencyLink(t, props.memberId, l.id))
              .then(() => reload())
              .catch((err: unknown) => setProblem(describeError(err)))
              .finally(() => {
                setBusy(false);
                setEnding(null);
              });
          }}
          onCancel={() => setEnding(null)}
        >
          <p>It stops working at once, and a page open with it stops too.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
