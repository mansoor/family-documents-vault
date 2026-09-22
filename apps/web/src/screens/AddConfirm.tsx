import {
  parseDateInput,
  type DocumentTypeView,
  type DocumentView,
  type Visibility,
} from '@fdv/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type DocumentInput, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { Button, ErrorNote, Field, Select, TopBar } from '../ui.js';

/**
 * Add: the phone's camera or a file picker (CAP-01 arrives with the mobile
 * app; the web PWA uses the camera input). The file is stored first, as a
 * Needs-info document, then the confirm card opens (CAP-05).
 */
export function AddScreen() {
  const { withToken } = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Arrived from a missing-document suggestion: it already knows what this
  // is and whose it is, so the confirm card should not ask again.
  const [params] = useSearchParams();
  const wanted = params.get('type');
  const forMember = params.get('member');
  const { data: hint } = useLoad(
    async (t) => {
      if (!wanted) return null;
      const [types, members] = await Promise.all([api.documentTypes(t), api.members(t)]);
      return {
        type: types.items.find((x) => x.key === wanted)?.label ?? null,
        member: members.items.find((m) => m.id === forMember)?.display_name ?? null,
      };
    },
    [wanted, forMember],
  );
  const carry = new URLSearchParams();
  if (wanted) carry.set('type', wanted);
  if (forMember) carry.set('member', forMember);
  const suffix = carry.toString() ? `?${carry.toString()}` : '';

  const chosen = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await withToken((t) => api.capture(t, file, crypto.randomUUID()));
      if (r) void navigate(`/documents/${r.document_id}/confirm${suffix}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page-top">
      <TopBar title="Add a document" back="/" />
      {hint?.type ? (
        <p className="lede">
          Adding {aOrAn(hint.type.toLowerCase())}
          {hint.member ? ` for ${hint.member}` : ''}. Take a photo or choose a file; the details are
          filled in for you on the next screen.
        </p>
      ) : (
        <p className="lede">
          Take a photo or choose a file. It is saved straight away; you can add the details next, or
          later.
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf,.heic,.tiff,.docx,.xlsx"
        capture="environment"
        aria-label="Choose a file"
        style={{ display: 'none' }}
        onChange={(e) => void chosen(e.target.files?.[0])}
      />
      <ErrorNote message={error} />
      <Button onClick={() => input.current?.click()} disabled={busy}>
        {busy ? 'Saving…' : 'Take a photo or choose a file'}
      </Button>
      <p className="muted">PDFs, photos and scans (JPEG, PNG, HEIC, TIFF), Word and Excel files.</p>
    </main>
  );
}

function aOrAn(noun: string): string {
  return `${'aeiou'.includes(noun[0] ?? '') ? 'an' : 'a'} ${noun}`;
}

/** The confirm card: type, person, dates, number, visibility. Pre-filled by OCR in a later release. */
export function ConfirmScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data, error: loadError } = useLoad(
    async (t) => {
      const [doc, types, members] = await Promise.all([
        api.document(t, id as string),
        api.documentTypes(t),
        api.members(t),
      ]);
      return { doc, types: types.items, members: members.items };
    },
    [id],
  );
  if (loadError)
    return (
      <main className="page page-top">
        <TopBar title="Is this right?" back="/" />
        <ErrorNote message={loadError} />
      </main>
    );
  if (!data)
    return (
      <main className="page page-top">
        <TopBar title="Is this right?" back="/" />
      </main>
    );
  return (
    <ConfirmForm
      doc={data.doc}
      types={data.types}
      members={data.members}
      suggested={{ typeKey: params.get('type'), memberId: params.get('member') }}
      onSaved={(d) => void navigate(`/documents/${d.id}`, { replace: true })}
      withToken={withToken}
    />
  );
}

export function ConfirmForm(props: {
  doc: DocumentView;
  types: DocumentTypeView[];
  members: Member[];
  /** Chosen for the user when they came from a missing-document suggestion. */
  suggested?: { typeKey: string | null; memberId: string | null };
  withToken: <T>(fn: (t: string) => Promise<T>) => Promise<T | null>;
  onSaved: (d: DocumentView) => void;
}) {
  const { doc, types, members } = props;
  const [typeKey, setTypeKey] = useState(doc.type_key ?? props.suggested?.typeKey ?? '');
  const [title, setTitle] = useState(doc.title ?? '');
  const [owner, setOwner] = useState(
    doc.owner_member_id ?? props.suggested?.memberId ?? members.find((m) => m.is_me)?.id ?? '',
  );
  const [issued, setIssued] = useState(doc.issued?.date ?? '');
  const [expires, setExpires] = useState(doc.expires?.date ?? '');
  const [identifier, setIdentifier] = useState(doc.identifier ?? '');
  const [location, setLocation] = useState(doc.physical_location ?? '');
  const [visibility, setVisibility] = useState<Visibility>(doc.visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = types.find((t) => t.key === typeKey);
  const me = members.find((m) => m.is_me);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const exp = expires ? parseDateInput(expires) : null;
    const iss = issued ? parseDateInput(issued) : null;
    if (expires && !exp) {
      setError('Enter the expiry as a date (2031-03-14), a month (2031-03) or a year (2031).');
      setBusy(false);
      return;
    }
    if (issued && !iss) {
      setError('Enter the issue date as a date (2021-03-14), a month (2021-03) or a year (2021).');
      setBusy(false);
      return;
    }
    const body: DocumentInput = {
      type_key: typeKey || null,
      title: title || null,
      owner_member_id: owner || null,
      identifier: identifier || null,
      physical_location: location || null,
      issued: iss,
      expires: exp,
    };
    // Only send visibility when it changed: the server rewraps keys for it.
    if (visibility !== doc.visibility) body.visibility = visibility;
    if (type) body.category = type.category;
    try {
      const saved = await props.withToken((t) => api.updateDocument(t, doc.id, body, doc.etag));
      if (saved) props.onSaved(saved);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const reminderText = type?.reminder_leads.length
    ? type.reminder_leads
        .map((d) => (d >= 60 ? `${Math.round(d / 30)} months` : `${d} days`))
        .join(' and ') + ' before'
    : null;

  return (
    <main className="page page-top">
      <TopBar title="Is this right?" back={`/documents/${doc.id}`} />
      <p className="lede">Change anything that is wrong. Everything else can wait.</p>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <Select
          id="f-type"
          label="What it is"
          value={typeKey}
          onChange={(v) => {
            setTypeKey(v);
            const t = types.find((x) => x.key === v);
            if (t && !title)
              setTitle(`${me?.display_name.split(' ')[0] ?? ''}'s ${t.label.toLowerCase()}`.trim());
            if (t) setVisibility(t.default_visibility);
          }}
          options={[
            { value: '', label: 'Not sure yet' },
            ...types.map((t) => ({ value: t.key, label: t.label })),
          ]}
        />
        <Field
          id="f-title"
          label="Name"
          value={title}
          onChange={setTitle}
          required={false}
          placeholder="Mansoor's passport"
        />
        <Select
          id="f-who"
          label="Whose it is"
          value={owner}
          onChange={setOwner}
          options={[
            { value: '', label: 'Not sure yet' },
            ...members.map((m) => ({ value: m.id, label: m.display_name })),
          ]}
        />
        <Field
          id="f-issued"
          label="Issued"
          value={issued}
          onChange={setIssued}
          required={false}
          placeholder="2021-03-14"
          hint="A date, a month (2021-03) or a year"
        />
        {(type?.expiry_driver || expires) && (
          <Field
            id="f-expires"
            label="Expires"
            value={expires}
            onChange={setExpires}
            required={false}
            placeholder="2031-03-14"
            hint="A date, a month (2031-03) or a year"
          />
        )}
        <Field
          id="f-number"
          label="Number"
          value={identifier}
          onChange={setIdentifier}
          required={false}
        />
        <Field
          id="f-location"
          label="Where the original is kept"
          value={location}
          onChange={setLocation}
          required={false}
          placeholder="Bedroom safe, top shelf"
        />
        {reminderText && (
          <p className="muted">
            <strong>Remind me before it expires:</strong> {reminderText}
          </p>
        )}
        <div className="field" role="group" aria-label="Who can see this">
          <span className="field-label">Who can see this</span>
          <div className="pills">
            {(
              [
                ['household', 'Everyone'],
                ['adults', 'Adults only'],
                ['private', 'Only me'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`pill${visibility === v ? ' pill-on' : ''}`}
                aria-pressed={visibility === v}
                disabled={v === 'private' && owner !== me?.id}
                onClick={() => setVisibility(v)}
              >
                {label}
              </button>
            ))}
          </div>
          {visibility === 'private' && (
            <span className="muted">
              Only you can open this. Nobody can open it after you, unless you leave a key.
            </span>
          )}
        </div>
        <ErrorNote message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save to the vault'}
        </Button>
      </form>
    </main>
  );
}
