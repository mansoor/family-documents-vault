import {
  autoTitle,
  effectiveVisibility,
  formatDate,
  issuedByLabel,
  issuerFromFilename,
  issuerKey,
  missingFields,
  parseDateInput,
  reminderSentence,
  type CaptureMetadata,
  type CoreField,
  type DateOrder,
  type DocumentTypeView,
  type DocumentView,
  type IssuerSuggestions,
  type KnownIssuer,
  type RequiredValues,
  type Visibility,
} from '@fdv/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError, type DocumentInput, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import {
  andList,
  asksFor,
  blankInput,
  choicesOf,
  coreRule,
  DetailField,
  detailInputs,
  readDetail,
  useAttributes,
  type DetailInput,
} from '../details.js';
import { Button, ErrorNote, Field, Select, TextArea, TopBar } from '../ui.js';
import { createUploadKeys, whileInProgress } from '../upload-keys.js';

/** The longest a note may be (POST /documents' limit). */
const NOTES_MAX = 10_000;

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
  if (d.notes !== undefined) out.notes = d.notes;
  if (d.extra !== undefined) out.extra = d.extra;
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
  const { withToken, guarded } = useApp();
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
      if (details && !(await putDetails(landed, details))) return;
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
   * somebody else needs it un-private first. False when that was not
   * confirmed: nothing more is changed, and Save again tries again.
   */
  const putDetails = async (id: string, details: CaptureMetadata): Promise<boolean> => {
    const current = await withToken((t) => api.document(t, id));
    if (!current) return false;
    const { visibility, ...rest } = details;
    const type = data?.types.find((x) => x.key === rest.type_key);
    const fields: DocumentInput = { ...rest };
    // As a fresh capture would have: the type's category, and no expiry
    // for a type that has none.
    if (type) fields.category = type.category;
    if (rest.type_key !== undefined && !type?.expiry_driver) fields.expires = null;
    // What the card shows now is what the document keeps: a detail or a
    // note the first try put there that the card has since cleared, or no
    // longer asks for, is taken away. (On an Only me document the vault
    // seals what it writes, as it does for every edit.)
    const extra: Record<string, unknown> = { ...rest.extra };
    for (const key of Object.keys(current.extra)) {
      if (!(key in extra)) extra[key] = null;
    }
    if (Object.keys(extra).length > 0) fields.extra = extra;
    if (rest.notes === undefined && (current.notes || current.has_notes)) fields.notes = null;
    const move = visibility && visibility !== current.visibility ? visibility : null;
    if (move && move !== 'private') {
      // Out of Only me asks what opening it asks (5.4).
      if (!(await guarded((t) => api.setVisibility(t, id, move)))) return false;
    }
    // No If-Match: a visibility change just now moved the etag on.
    await withToken((t) => api.updateDocument(t, id, fields));
    if (move === 'private') await withToken((t) => api.setVisibility(t, id, move));
    return true;
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
          notes: '',
          details: {},
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

/**
 * Save found the document changed somewhere else since the card was filled
 * (409): what it holds now, as the card holds it, to be taken in.
 */
class ChangedElsewhere extends Error {
  constructor(readonly now: CardValues) {
    super('Someone else changed this document.');
    this.name = 'ChangedElsewhere';
  }
}

/** The document as the vault holds it now: it sends it with a 409 (0.5.7). */
function heldNow(err: ApiRequestError): DocumentView | null {
  try {
    const doc = JSON.parse(err.detail ?? '') as Partial<DocumentView> | null;
    return doc && typeof doc.id === 'string' && typeof doc.etag === 'string'
      ? (doc as DocumentView)
      : null;
  } catch {
    return null;
  }
}

/** The confirm card for a document already in the vault: its details, changed in place. */
export function ConfirmScreen() {
  const { id } = useParams<{ id: string }>();
  const { guarded, withToken } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const {
    data,
    error: loadError,
    setData,
  } = useLoad(
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
  /** A document as the card holds it: its dates as a person writes them ("June 2027"). */
  const cardFor = (d: DocumentView): CardValues => {
    const owner =
      members.find((m) => m.id === d.owner_member_id) ??
      suggestedOwner ??
      members.find((m) => m.is_me);
    const typeKey = d.type_key ?? suggestedType?.key ?? '';
    const type = types.find((t) => t.key === typeKey);
    return {
      typeKey,
      title: d.title ?? '',
      owner: owner?.id ?? '',
      issuer: d.issued_by ?? '',
      issued: d.issued ? formatDate(d.issued) : '',
      expires: d.expires ? formatDate(d.expires) : '',
      identifier: d.identifier ?? '',
      location: d.physical_location ?? '',
      visibility: d.visibility,
      // Its own request, so an Only me document's are open here (0.5.8).
      // Notes that are there but could not be opened are not offered to
      // be typed over.
      notes: d.notes ?? (d.has_notes ? null : ''),
      details: detailInputs(d.extra, type?.fields ?? []),
    };
  };
  return (
    <ConfirmForm
      title="Is this right?"
      back={`/documents/${doc.id}`}
      lede="Change anything that is wrong. Everything else can wait."
      documentId={doc.id}
      types={types}
      members={members}
      initial={cardFor(doc)}
      submitLabel="Save to the vault"
      onSubmit={async (details) => {
        // Only send visibility when it changed: the server rewraps keys for it.
        if (details.visibility === doc.visibility) delete details.visibility;
        let saved: DocumentView | null;
        try {
          // Out of Only me asks what opening it asks (5.4); not confirmed,
          // nothing is saved and the card stays.
          saved = await guarded((t) => api.updateDocument(t, doc.id, details, doc.etag));
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
          // Changed somewhere else since the card was filled: what it holds
          // now is taken in, what was typed is kept, and the next Save is
          // made on top of it.
          const now = heldNow(err) ?? (await withToken((t) => api.document(t, doc.id)));
          if (!now) throw err;
          setData({ doc: now, types, members });
          throw new ChangedElsewhere(cardFor(now));
        }
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
  /** Plain text, line breaks kept. Null: it has notes this card cannot open. */
  notes: string | null;
  /** The type's own details as the card holds them, by field key (5.10). */
  details: Record<string, DetailInput>;
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
  // What the document held when the card was filled, which Save compares
  // with: moved on when Save finds it changed somewhere else since.
  const [base, setBase] = useState(initial);
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
  const [notes, setNotes] = useState(initial.notes ?? '');
  // The type's own details, by field key. A key stays when the type
  // changes, so a field the next type shares keeps what was typed.
  const [detailValues, setDetailValues] = useState<Record<string, DetailInput>>(initial.details);
  // Once Save has waited for them, the fields it waited for say so.
  const [waited, setWaited] = useState(false);
  // The field Save could not read, marked until it is changed.
  const [unread, setUnread] = useState<string | null>(null);
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
  const editing = !props.fileName;
  const expiresShown = Boolean(type?.expiry_driver) || (editing && expires !== '');
  const issuerLabel = issuedByLabel(type);

  const order = dateOrder();

  // What the vault requires of this type, by the vault's own rule
  // (missingFields, @fdv/shared): everything it would find missing from a
  // document with nothing in it. So an expiry date is required for every
  // type that expires, as the document would then say it needs one.
  const required = new Set(missingFields(type, {}).map((m) => m.key));
  // The fixed fields as the type asks for them (0.5.6): its own label
  // ('Passport number', not 'Number'), whether it is shown, whether Save
  // waits for it. One a document already has a value for is shown for
  // editing whatever the type says now, so nothing is kept out of reach.
  const shows = (key: CoreField, had: string | null) =>
    coreRule(type, key).shown || (editing && Boolean(had?.trim()));
  const asks = (key: CoreField) => required.has(key);
  const word = (key: CoreField, fallback: string) => coreRule(type, key).label ?? fallback;
  const issuerShown = shows('issued_by', base.issuer);
  const issuedShown = shows('issued', base.issued);
  const identifierShown = shows('identifier', base.identifier);
  const locationShown = shows('physical_location', base.location);
  // Notes that are there but could not be opened are never typed over.
  const notesShown = base.notes !== null && shows('notes', base.notes);
  const issuedLabel = word('issued', 'Issued');
  const expiresLabel = word('expires', 'Expires');
  const identifierLabel = word('identifier', 'Number');
  const locationLabel = word('physical_location', 'Where the original is kept');
  const notesLabel = word('notes', 'Notes');

  // Then the type's own fields, each with the input its kind asks for.
  const ownFields = (type?.fields ?? []).filter(asksFor);
  const library = useAttributes(ownFields.some((f) => f.kind === 'choice' && !f.choices?.length));
  const detailId = (key: string) => `f-x-${key}`;

  /** A required switch left alone says no, as it shows (and is sent so). */
  const answerOf = (f: { required?: boolean }, now: DetailInput | undefined) =>
    now ?? (f.required === true ? false : null);
  /**
   * What Save waits for, in the card's order: what the vault would find
   * missing from the document as the card holds it (A7), by the same rule,
   * so the card and the document never disagree. A field the card has no
   * input for is not waited for.
   */
  const held: RequiredValues = {
    issued_by: issuer,
    issued: issued.trim() ? parseDateInput(issued, { order }) : null,
    expires: expires.trim() ? parseDateInput(expires, { order }) : null,
    identifier,
    physical_location: location,
    notes,
    extra: Object.fromEntries(
      ownFields.map((f) => [
        f.key,
        f.kind === 'yes_no' ? answerOf(f, detailValues[f.key]) : detailValues[f.key],
      ]),
    ),
  };
  const needed = new Set(missingFields(type, held).map((m) => m.key));
  const missing = [
    { key: 'issued_by', id: 'f-issuer', label: issuerLabel, shown: issuerShown },
    { key: 'issued', id: 'f-issued', label: issuedLabel, shown: issuedShown },
    { key: 'expires', id: 'f-expires', label: expiresLabel, shown: expiresShown },
    { key: 'identifier', id: 'f-number', label: identifierLabel, shown: identifierShown },
    { key: 'physical_location', id: 'f-location', label: locationLabel, shown: locationShown },
    ...ownFields.map((f) => ({ key: f.key, id: detailId(f.key), label: f.label, shown: true })),
    { key: 'notes', id: 'f-notes', label: notesLabel, shown: notesShown },
  ]
    .filter((f) => f.shown && needed.has(f.key))
    .map(({ id, label }) => ({ id, label }));
  /**
   * Marked once Save has waited for it, until it is filled; or once Save
   * could not read it, until it is changed.
   */
  const invalid = (id: string) => unread === id || (waited && missing.some((m) => m.id === id));
  /** A field changed: if Save could not read it, it is not marked any more. */
  const changed = (id: string) => setUnread((was) => (was === id ? null : was));

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

  /**
   * The document as it is now, after somebody else changed it while the
   * card was open: what they changed is taken in, wherever this card left
   * it as it was; what was typed here is kept. Save compares with it next.
   */
  const takeIn = (now: CardValues) => {
    const kept =
      <T,>(was: T, then: T) =>
      (typed: T) =>
        typed === was ? then : typed;
    setTypeKey(kept(base.typeKey, now.typeKey));
    setTitle(kept(base.title, now.title));
    setOwner(kept(base.owner, now.owner));
    setIssuer(kept(base.issuer, now.issuer));
    setIssued(kept(base.issued, now.issued));
    setExpires(kept(base.expires, now.expires));
    setIdentifier(kept(base.identifier, now.identifier));
    setLocation(kept(base.location, now.location));
    setVisibility(kept(base.visibility, now.visibility));
    setNotes(kept(base.notes ?? '', now.notes ?? ''));
    setDetailValues((typed) => {
      const out = { ...typed };
      for (const key of new Set([...Object.keys(base.details), ...Object.keys(now.details)])) {
        const was = base.details[key];
        const left = blankInput(typed[key]) ? blankInput(was) : typed[key] === was;
        if (!left) continue;
        const then = now.details[key];
        if (then === undefined) delete out[key];
        else out[key] = then;
      }
      return out;
    });
    setBase(now);
    setWaited(false);
    setUnread(null);
  };

  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (err) {
      if (err instanceof ChangedElsewhere) {
        takeIn(err.now);
        setError(
          'Someone else changed this document while you had it open. Their changes are on the card now, and yours are kept: check it, then save again.',
        );
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  /** The card's words for what went wrong, with the place on the field it is about. */
  const refuse = (message: string, id: string) => {
    setError(message);
    document.getElementById(id)?.focus();
  };
  /** A value Save could not read: said, marked, and the place on it. */
  const unreadable = (message: string, id: string) => {
    setUnread(id);
    refuse(message, id);
  };

  /**
   * Save: the dates and details read as the vault keeps them, then — unless
   * `anyway` — every required field given (Save waits, and says which are
   * missing; A7). Skip for now never waits.
   */
  const submit = async (anyway: boolean) => {
    // A new document sends an expiry only for a type that expires; editing
    // sends it once it is changed, so clearing the field clears the date. A
    // date the edit card did not change is not sent: it keeps how it was
    // written (June 2027 stays a month).
    const sendExpiry = editing ? expires.trim() !== base.expires.trim() : expiresShown;
    const sendIssued = issuedShown && (!editing || issued.trim() !== base.issued.trim());
    const exp = sendExpiry && expires ? parseDateInput(expires, { order }) : null;
    const iss = sendIssued && issued ? parseDateInput(issued, { order }) : null;
    if (sendExpiry && expires && !exp) {
      unreadable('The expiry date: try 14 Mar 2031, March 2031, or just 2031.', 'f-expires');
      return;
    }
    if (sendIssued && issued && !iss) {
      unreadable('The issue date: try 14 Mar 2021, March 2021, or just 2021.', 'f-issued');
      return;
    }
    // Only the details that changed are sent: an edit merges them (0.5.7),
    // so one the card did not change — an Only me document's included — is
    // left exactly as it is kept.
    const extra: Record<string, unknown> = {};
    for (const f of ownFields) {
      const now = detailValues[f.key];
      const was = base.details[f.key];
      if (f.kind === 'yes_no') {
        const answer = answerOf(f, now);
        if (answer !== null && answer !== (was ?? null)) extra[f.key] = answer;
        continue;
      }
      if ((now ?? '') === (was ?? '')) continue;
      const read = readDetail({ ...f, choices: choicesOf(f, library) }, now, order);
      if ('message' in read) {
        unreadable(read.message, detailId(f.key));
        return;
      }
      if (read.value !== null) extra[f.key] = read.value;
      else if (editing && !blankInput(was)) extra[f.key] = null;
    }
    const [first] = missing;
    if (!anyway && first) {
      setWaited(true);
      const them = missing.length === 1 ? 'it' : 'them';
      refuse(
        `Still needed: ${andList(missing.map((m) => m.label))}. ${
          props.onSkip
            ? `Fill ${them} in, or skip for now.`
            : `Fill ${them} in, or save without ${them}.`
        }`,
        first.id,
      );
      return;
    }
    const details: DocumentInput = {
      type_key: typeKey || null,
      title: title.trim() || null,
      owner_member_id: owner || null,
      visibility,
    };
    // A field the card does not show is left as it is.
    if (issuerShown) details.issued_by = issuer.trim() || null;
    if (identifierShown) details.identifier = identifier.trim() || null;
    if (locationShown) details.physical_location = location.trim() || null;
    if (sendIssued) details.issued = iss;
    if (sendExpiry) details.expires = exp;
    // Sealed as it is written on an Only me document (0.5.8).
    if (notesShown && notes !== (base.notes ?? '')) details.notes = notes.trim() || null;
    if (Object.keys(extra).length > 0) details.extra = extra;
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        className="stack"
        noValidate
      >
        <Select
          id="f-type"
          label="What it is"
          value={typeKey}
          onChange={(v) => {
            setTypeKey(v);
            // Another type asks for other things: nothing is marked until
            // Save has waited for them.
            setWaited(false);
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
        {issuerShown && (
          <Field
            id="f-issuer"
            label={issuerLabel}
            value={issuer}
            onChange={chooseIssuer}
            required={false}
            requiredMark={asks('issued_by')}
            invalid={invalid('f-issuer')}
          />
        )}
        {issuerShown && issuer.trim() === '' && offers.length > 0 && (
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
        {issuedShown && (
          <Field
            id="f-issued"
            label={issuedLabel}
            value={issued}
            onChange={(v) => {
              setIssued(v);
              changed('f-issued');
              retitle({ issued: v });
            }}
            required={false}
            requiredMark={asks('issued')}
            invalid={invalid('f-issued')}
            placeholder="14 Mar 2021"
            hint="A date, a month (March 2021) or a year"
          />
        )}
        {expiresShown && (
          <Field
            id="f-expires"
            label={expiresLabel}
            value={expires}
            onChange={(v) => {
              setExpires(v);
              changed('f-expires');
            }}
            required={false}
            requiredMark={asks('expires')}
            invalid={invalid('f-expires')}
            placeholder="14 Mar 2031"
            hint="A date, a month (March 2031) or a year"
          />
        )}
        {identifierShown && (
          <Field
            id="f-number"
            label={identifierLabel}
            value={identifier}
            onChange={setIdentifier}
            required={false}
            requiredMark={asks('identifier')}
            invalid={invalid('f-number')}
          />
        )}
        {locationShown && (
          <Field
            id="f-location"
            label={locationLabel}
            value={location}
            onChange={setLocation}
            required={false}
            requiredMark={asks('physical_location')}
            invalid={invalid('f-location')}
            placeholder="Bedroom safe, top shelf"
          />
        )}
        {reminder && <p className="muted">{reminder}</p>}
        {ownFields.map((f) => (
          <DetailField
            key={f.key}
            id={detailId(f.key)}
            field={f}
            choices={choicesOf(f, library)}
            value={detailValues[f.key]}
            invalid={invalid(detailId(f.key))}
            onChange={(v) => {
              setDetailValues((was) => ({ ...was, [f.key]: v }));
              changed(detailId(f.key));
            }}
          />
        ))}
        {notesShown && (
          <TextArea
            id="f-notes"
            label={notesLabel}
            value={notes}
            maxLength={NOTES_MAX}
            onChange={setNotes}
            requiredMark={asks('notes')}
            invalid={invalid('f-notes')}
            hint={
              visibility === 'private'
                ? 'Sealed with the document, so only you can read them.'
                : undefined
            }
          />
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
        ) : (
          // A document already in the vault has no Skip: once Save has
          // waited, what was changed can still be kept, and the document
          // says what it needs (A7).
          waited &&
          missing.length > 0 && (
            <Button kind="quiet" disabled={busy} onClick={() => void submit(true)}>
              {missing.length === 1 ? 'Save without it' : 'Save without them'}
            </Button>
          )
        )}
      </form>
    </main>
  );
}
