import {
  autoTitle,
  effectiveVisibility,
  issuedByLabel,
  issuerFromFilename,
  issuerKey,
  parseDateInput,
  reminderSentence,
  type CaptureMetadata,
  type DateOrder,
  type DocumentTypeView,
  type IssuerSuggestions,
  type KnownIssuer,
  type Visibility,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError, type DocumentInput, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { Button, ErrorNote, Field, Select, TopBar } from '../ui.js';
import { createUploadKeys, whileInProgress } from '../upload-keys.js';

/**
 * The order a numeric date is read in, from the browser's locale: 14/03 or
 * 03/14. Only a locale that writes the month first, then the day, then the
 * year (the US) reads 03/04 as March; year-first locales write dates as
 * 2031-03-14, and read a slashed date day first like most of the world.
 */
function dateOrder(): DateOrder {
  const parts = new Intl.DateTimeFormat(undefined).formatToParts(new Date(2031, 2, 14));
  const at = (type: string) => parts.findIndex((p) => p.type === type);
  return at('month') >= 0 && at('month') < at('day') && at('day') < at('year') ? 'mdy' : 'dmy';
}

/** The card's details as a capture sends them: only what the card asks. */
function captureDetails(d: DocumentInput): CaptureMetadata {
  const out: CaptureMetadata = {};
  if (d.type_key !== undefined) out.type_key = d.type_key;
  if (d.title !== undefined) out.title = d.title;
  if (d.owner_member_id !== undefined) out.owner_member_id = d.owner_member_id;
  if (d.visibility !== undefined) out.visibility = d.visibility;
  if (d.issued !== undefined) out.issued = d.issued;
  if (d.expires !== undefined) out.expires = d.expires;
  if (d.identifier !== undefined) out.identifier = d.identifier;
  if (d.issued_by !== undefined) out.issued_by = d.issued_by;
  if (d.physical_location !== undefined) out.physical_location = d.physical_location;
  return out;
}

/**
 * Add: the phone's camera or a file picker (CAP-01 arrives with the mobile
 * app; the web PWA uses the camera input). Choose the file, fill the card,
 * then Save — or Skip, and fill it later. Nothing leaves the browser until
 * then, and then one request carries the file and its details (0.4.9), so
 * the document is filed complete, and for the right people, from the start.
 */
export function AddScreen() {
  const { withToken } = useApp();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [keys] = useState(createUploadKeys);
  const input = useRef<HTMLInputElement>(null);
  // Arrived from a missing-document suggestion: it already knows what this
  // is and whose it is, so the card starts with both.
  const [params] = useSearchParams();
  const wanted = params.get('type');
  const forMember = params.get('member');
  const { data, error: loadError } = useLoad(async (t) => {
    const [types, members] = await Promise.all([api.documentTypes(t), api.members(t)]);
    return { types: types.items, members: members.items };
  }, []);
  const hintType = data?.types.find((x) => x.key === wanted)?.label ?? null;
  const hintMember = data?.members.find((m) => m.id === forMember)?.display_name ?? null;

  // The last try that failed: under which key, with what details, and —
  // once the vault has said it landed — the document it made.
  const lastTry = useRef<{ key: string; details: string; documentId?: string } | null>(null);

  /**
   * One capture, with the card's details or (Skip) without. A Save again
   * with the same details is a retry with the same key, answered with what
   * the first try made if it landed. A Save again after the card changed
   * asks first what became of the earlier try: if it landed, the new
   * details are put on that document (Only me included); if not, the file
   * goes afresh under a new key.
   */
  const save = async (chosen: File, details: CaptureMetadata | undefined) => {
    const sent = JSON.stringify(details ?? null);
    let key = keys.keyFor(chosen);
    const prior = lastTry.current?.key === key ? lastTry.current : null;
    let landed = prior?.documentId;
    if (prior && !landed && prior.details !== sent) {
      const status = await withToken((t) => api.uploadStatus(t, key)).catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      });
      if (status?.state === 'in_progress') {
        throw new ApiRequestError(
          409,
          'upload_in_progress',
          'This upload is already on its way. Try again in a moment.',
          undefined,
          { retriable: true },
        );
      }
      if (status?.state === 'done') landed = status.document_id;
      else {
        // Nothing landed: the new details go with a new key.
        keys.saved();
        key = keys.keyFor(chosen);
      }
    }
    if (landed) {
      lastTry.current = { key, details: sent, documentId: landed };
      if (details) await putDetails(landed, details);
      keys.saved();
      lastTry.current = null;
      void navigate(`/documents/${landed}`, { replace: true });
      return;
    }
    lastTry.current = { key, details: sent };
    const r = await whileInProgress(() => withToken((t) => api.capture(t, chosen, key, details)));
    keys.saved();
    lastTry.current = null;
    if (r) void navigate(`/documents/${r.document_id}`, { replace: true });
  };

  /**
   * The card's details, put on a document an earlier try made. Who can see
   * it and whose it is are changed in the order the vault allows: making
   * it Only me needs it to be yours first; giving an Only me document to
   * somebody else needs it un-private first.
   */
  const putDetails = async (id: string, details: CaptureMetadata) => {
    const current = await withToken((t) => api.document(t, id));
    if (!current) return;
    const { visibility, ...rest } = details;
    const type = data?.types.find((x) => x.key === rest.type_key);
    const fields: DocumentInput = { ...rest };
    // As a fresh capture would have: the type's category, and no expiry
    // for a type that has none.
    if (type) fields.category = type.category;
    if (rest.type_key !== undefined && !type?.expiry_driver) fields.expires = null;
    const move = visibility && visibility !== current.visibility ? visibility : null;
    if (move && move !== 'private') {
      await withToken((t) => api.setVisibility(t, id, move));
    }
    // No If-Match: a visibility change just now moved the etag on.
    await withToken((t) => api.updateDocument(t, id, fields));
    if (move === 'private') await withToken((t) => api.setVisibility(t, id, move));
  };

  if (file && data) {
    const type = data.types.find((x) => x.key === wanted);
    const me = data.members.find((m) => m.is_me);
    const suggested = data.members.find((m) => m.id === forMember);
    const owner = me?.role === 'teen' ? me : (suggested ?? me);
    return (
      <ConfirmForm
        title="Is this right?"
        back="/"
        lede="Change anything that is wrong. Everything else can wait."
        fileName={file.name}
        types={data.types}
        members={data.members}
        initial={{
          typeKey: type?.key ?? '',
          title: type ? autoTitle(type, owner) : '',
          owner: owner?.id ?? '',
          issuer: '',
          issued: '',
          expires: '',
          identifier: '',
          location: '',
          visibility: effectiveVisibility({}, type, me?.role ?? 'owner'),
        }}
        submitLabel="Save to the vault"
        onSubmit={(details) => save(file, captureDetails(details))}
        onSkip={() => save(file, undefined)}
        onChooseAgain={() => setFile(null)}
      />
    );
  }

  return (
    <main className="page page-top">
      <TopBar title="Add a document" back="/" />
      {hintType ? (
        <p className="lede">
          Adding {aOrAn(hintType.toLowerCase())}
          {hintMember ? ` for ${hintMember}` : ''}. Take a photo or choose a file; the details are
          filled in for you on the next screen.
        </p>
      ) : (
        <p className="lede">
          Take a photo or choose a file. Then say what it is, or skip that and fill it in later.
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf,.heic,.tiff,.docx,.xlsx"
        capture="environment"
        aria-label="Choose a file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          // Cleared, so the same file can be chosen again.
          e.target.value = '';
          if (chosen) setFile(chosen);
        }}
      />
      <ErrorNote message={loadError} />
      <Button onClick={() => input.current?.click()} disabled={!data}>
        Take a photo or choose a file
      </Button>
      <p className="muted">PDFs, photos and scans (JPEG, PNG, HEIC, TIFF), Word and Excel files.</p>
    </main>
  );
}

function aOrAn(noun: string): string {
  return `${'aeiou'.includes(noun[0] ?? '') ? 'an' : 'a'} ${noun}`;
}

/** The confirm card for a document already in the vault: its details, changed in place. */
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
  const { doc, types, members } = data;
  const suggestedType = types.find((t) => t.key === params.get('type'));
  const suggestedOwner = members.find((m) => m.id === params.get('member'));
  const owner =
    members.find((m) => m.id === doc.owner_member_id) ??
    suggestedOwner ??
    members.find((m) => m.is_me);
  const typeKey = doc.type_key ?? suggestedType?.key ?? '';
  return (
    <ConfirmForm
      title="Is this right?"
      back={`/documents/${doc.id}`}
      lede="Change anything that is wrong. Everything else can wait."
      documentId={doc.id}
      types={types}
      members={members}
      initial={{
        typeKey,
        title: doc.title ?? '',
        owner: owner?.id ?? '',
        issuer: doc.issued_by ?? '',
        issued: doc.issued?.date ?? '',
        expires: doc.expires?.date ?? '',
        identifier: doc.identifier ?? '',
        location: doc.physical_location ?? '',
        visibility: doc.visibility,
      }}
      submitLabel="Save to the vault"
      onSubmit={async (details) => {
        // Only send visibility when it changed: the server rewraps keys for it.
        if (details.visibility === doc.visibility) delete details.visibility;
        const saved = await withToken((t) => api.updateDocument(t, doc.id, details, doc.etag));
        if (saved) void navigate(`/documents/${saved.id}`, { replace: true });
      }}
    />
  );
}

/** Everything the card holds, as typed. */
interface CardValues {
  typeKey: string;
  title: string;
  owner: string;
  /** Who issued it: the bank, the utility, the insurer, the country. */
  issuer: string;
  issued: string;
  expires: string;
  identifier: string;
  location: string;
  visibility: Visibility;
}

/** How many issuers the card offers at once. */
const ISSUER_OFFERS = 5;
/** While the vault is still reading the pages, it is asked again this often… */
const PAGES_PENDING_EVERY_MS = 5_000;
/** …this many times: for up to a minute. */
const PAGES_PENDING_TRIES = 12;

/**
 * Who the card offers as the issuer (0.4.10), each as a question the person
 * answers with a tap — never filled in for them. For a document already in
 * the vault, who its pages say issued it first (asked again while the
 * vault is still reading them, as long as the field is empty); for a new
 * file, the household's issuers whose names are in the file's name; then
 * the household's issuers, those used for this type first.
 */
function useIssuerOffers(opts: {
  fileName: string | undefined;
  documentId: string | undefined;
  typeKey: string;
  /** False once the field has a value: nothing more is asked for. */
  wanted: boolean;
}): string[] {
  const { fileName, documentId, typeKey, wanted } = opts;
  const { withToken } = useApp();
  const [household, setHousehold] = useState<KnownIssuer[]>([]);
  const [fromPages, setFromPages] = useState<IssuerSuggestions['items']>([]);
  const pagesSettled = useRef(false);
  const pagesTries = useRef(0);

  useEffect(() => {
    let cancelled = false;
    withToken((t) => api.issuers(t, typeKey ? { type_key: typeKey } : {}))
      .then((r) => {
        if (!cancelled && r) {
          setHousehold(r.items.map((i) => ({ value: i.issued_by, count: i.count })));
        }
      })
      // An offer, not a need: the card works without it.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [typeKey, withToken]);

  useEffect(() => {
    if (!documentId || !wanted || pagesSettled.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const r = await withToken((t) => api.issuerSuggestions(t, documentId));
        if (stopped || !r) return;
        if (r.state === 'ready') {
          pagesSettled.current = true;
          setFromPages(r.items);
        } else if (r.state === 'unavailable') {
          pagesSettled.current = true;
        } else if (pagesTries.current < PAGES_PENDING_TRIES) {
          pagesTries.current += 1;
          timer = setTimeout(() => void ask(), PAGES_PENDING_EVERY_MS);
        }
      } catch {
        // Likewise: without its pages, the household's issuers are offered.
      }
    };
    void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [documentId, wanted, withToken]);

  const inName = fileName ? issuerFromFilename(fileName, household).map((c) => c.value) : [];
  const seen = new Set<string>();
  const offers: string[] = [];
  for (const value of [
    ...fromPages.map((s) => s.value),
    ...inName,
    ...household.map((k) => k.value),
  ]) {
    const key = issuerKey(value);
    if (!value.trim() || seen.has(key)) continue;
    seen.add(key);
    offers.push(value);
  }
  return offers.slice(0, ISSUER_OFFERS);
}

export function ConfirmForm(props: {
  title: string;
  back: string;
  lede: string;
  /** The file this card is about, when it has not been sent yet. */
  fileName?: string;
  /** The document this card is about, when it is already in the vault. */
  documentId?: string;
  types: DocumentTypeView[];
  members: Member[];
  initial: CardValues;
  submitLabel: string;
  /** Throws to keep the card open with the vault's words. */
  onSubmit: (details: DocumentInput) => Promise<void>;
  /** Save without details: offered for a new document only. */
  onSkip?: () => Promise<void>;
  onChooseAgain?: () => void;
}) {
  const { types, members, initial } = props;
  const [typeKey, setTypeKey] = useState(initial.typeKey);
  const [title, setTitle] = useState(initial.title);
  // The name follows the type, the person, the issuer and the month until
  // somebody types one.
  const [titleTyped, setTitleTyped] = useState(initial.title !== '' && !props.fileName);
  const [owner, setOwner] = useState(initial.owner);
  const [issuer, setIssuer] = useState(initial.issuer);
  const [issued, setIssued] = useState(initial.issued);
  const [expires, setExpires] = useState(initial.expires);
  const [identifier, setIdentifier] = useState(initial.identifier);
  const [location, setLocation] = useState(initial.location);
  const [visibility, setVisibility] = useState<Visibility>(initial.visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = types.find((t) => t.key === typeKey);
  const me = members.find((m) => m.is_me);
  const myRole = me?.role ?? 'owner';
  const teen = myRole === 'teen';
  // A teen cannot see Adults only documents, their own included.
  const adultsOnlyAllowed = !teen;
  // A teen files their own documents, and cannot change who can see one
  // already in the vault.
  const people = teen ? members.filter((m) => m.is_me) : members;
  const visibilityLocked = teen && !props.fileName;
  const person = members.find((m) => m.id === owner);
  const expiresShown = Boolean(type?.expiry_driver) || (!props.fileName && expires !== '');
  const issuerLabel = issuedByLabel(type);
  const offers = useIssuerOffers({
    fileName: props.fileName,
    documentId: props.documentId,
    typeKey,
    wanted: issuer.trim() === '',
  });

  /** The name nobody typed, from what the card says now and what just changed. */
  const nameFor = (
    next: {
      type?: DocumentTypeView | null;
      who?: Member | null;
      issuer?: string;
      issued?: string;
    } = {},
  ): string => {
    const t = next.type !== undefined ? next.type : type;
    if (!t) return '';
    const when = next.issued ?? issued;
    return autoTitle(t, next.who !== undefined ? next.who : person, {
      issued_by: next.issuer ?? issuer,
      issued: when.trim() ? parseDateInput(when, { order: dateOrder() }) : null,
    });
  };
  const retitle = (next: Parameters<typeof nameFor>[0]) => {
    if (!titleTyped) setTitle(nameFor(next));
  };
  const chooseIssuer = (v: string) => {
    setIssuer(v);
    retitle({ issuer: v });
  };

  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const order = dateOrder();
    // A new document sends an expiry only for a type that expires; editing
    // always sends it, so clearing the field clears the date.
    const sendExpiry = expiresShown || !props.fileName;
    const exp = sendExpiry && expires ? parseDateInput(expires, { order }) : null;
    const iss = issued ? parseDateInput(issued, { order }) : null;
    if (sendExpiry && expires && !exp) {
      setError('The expiry date: try 14 Mar 2031, March 2031, or just 2031.');
      return;
    }
    if (issued && !iss) {
      setError('The issue date: try 14 Mar 2021, March 2021, or just 2021.');
      return;
    }
    const details: DocumentInput = {
      type_key: typeKey || null,
      title: title.trim() || null,
      owner_member_id: owner || null,
      issued_by: issuer.trim() || null,
      identifier: identifier.trim() || null,
      physical_location: location.trim() || null,
      issued: iss,
      visibility,
    };
    if (sendExpiry) details.expires = exp;
    if (type) details.category = type.category;
    await run(() => props.onSubmit(details));
  };

  const reminder = reminderSentence(type);

  return (
    <main className="page page-top">
      <TopBar title={props.title} back={props.back} />
      <p className="lede">{props.lede}</p>
      {props.fileName ? (
        <p className="muted">
          {props.fileName}
          {props.onChooseAgain ? (
            <>
              {' · '}
              <Button kind="link" onClick={props.onChooseAgain} disabled={busy}>
                Choose another file
              </Button>
            </>
          ) : null}
        </p>
      ) : null}
      <form onSubmit={(e) => void submit(e)} className="stack">
        <Select
          id="f-type"
          label="What it is"
          value={typeKey}
          onChange={(v) => {
            setTypeKey(v);
            const t = types.find((x) => x.key === v);
            retitle({ type: t ?? null });
            // A new document takes the type's default; an existing one keeps
            // who can see it until somebody chooses otherwise.
            if (t && props.fileName) {
              const next = effectiveVisibility({}, t, myRole);
              setVisibility(next === 'private' && owner !== me?.id ? 'household' : next);
            }
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
          onChange={(v) => {
            setTitle(v);
            setTitleTyped(v !== '');
          }}
          required={false}
          placeholder={type ? nameFor() : "Aisha's passport"}
        />
        <Select
          id="f-who"
          label="Whose it is"
          value={owner}
          onChange={(v) => {
            setOwner(v);
            retitle({ who: members.find((m) => m.id === v) ?? null });
            // Only me is for your own documents.
            if (visibility === 'private' && v !== me?.id) {
              setVisibility(adultsOnlyAllowed ? 'adults' : 'household');
            }
          }}
          options={[
            { value: '', label: 'Not sure yet' },
            ...people.map((m) => ({ value: m.id, label: m.display_name })),
          ]}
        />
        <Field
          id="f-issuer"
          label={issuerLabel}
          value={issuer}
          onChange={chooseIssuer}
          required={false}
        />
        {issuer.trim() === '' && offers.length > 0 && (
          <div className="pills" role="group" aria-label="Who it might be from">
            {offers.map((name) => (
              <button
                key={name}
                type="button"
                className="pill"
                onClick={() => {
                  chooseIssuer(name);
                  // The chips go once the field is filled: keep the place on the field.
                  document.getElementById('f-issuer')?.focus();
                }}
              >
                {`From ${name}?`}
              </button>
            ))}
          </div>
        )}
        <Field
          id="f-issued"
          label="Issued"
          value={issued}
          onChange={(v) => {
            setIssued(v);
            retitle({ issued: v });
          }}
          required={false}
          placeholder="14 Mar 2021"
          hint="A date, a month (March 2021) or a year"
        />
        {expiresShown && (
          <Field
            id="f-expires"
            label="Expires"
            value={expires}
            onChange={setExpires}
            required={false}
            placeholder="14 Mar 2031"
            hint="A date, a month (March 2031) or a year"
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
        {reminder && <p className="muted">{reminder}</p>}
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
                disabled={
                  (v === 'private' && owner !== me?.id) ||
                  (v === 'adults' && !adultsOnlyAllowed) ||
                  (visibilityLocked && v !== visibility)
                }
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
          {busy ? 'Saving…' : props.submitLabel}
        </Button>
        {props.onSkip ? (
          <Button
            kind="quiet"
            disabled={busy}
            onClick={() => void run(props.onSkip as () => Promise<void>)}
          >
            Skip for now
          </Button>
        ) : null}
      </form>
    </main>
  );
}
