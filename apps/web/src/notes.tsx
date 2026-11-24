import {
  looksSecret,
  noteLinkAllowed,
  SENSITIVE_LABEL,
  SENSITIVE_MEANS,
  TEEN_KEEPS_SENSITIVE,
  NOTES_MAX,
  notesPlainText,
  noteTreeText,
  parseNotes,
  type DocumentView,
  type NoteBlock,
  type NoteInline,
} from '@fdv/shared';
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp } from './app-context.js';
import {
  draftOf,
  forgetDraft,
  keepDraft,
  keepsDrafts,
  type DraftOwner,
  type NoteDraft,
} from './note-drafts.js';
import { RichTextEditor } from './rich-text.js';
import { Button, ErrorNote, Switch, useNamedWithin } from './ui.js';
import { storedRole } from './session.js';
import { exactWords } from './family-time.js';

/**
 * A note on the web (5.35, A30; 0.9.0, N1): a document's note, or a note
 * kept on its own — read by whoever sees it, written by whoever may change
 * it, in the one editor (rich-text.tsx).
 *
 * A note is drawn from the tree `@fdv/shared` reads it into, as React
 * elements, and never as an HTML string: whatever somebody types — a
 * `<script>`, an image, a `javascript:` link — is shown as the characters it
 * is. A link goes only to https, http or mailto, opens with
 * `rel="noopener noreferrer"`, and shows its address beside its words — as
 * the browser will reach it, its host in punycode, isolated from any
 * direction its neighbours set (the 5.35 review, X535-02).
 */

// ---------------------------------------------------------------- reading

/**
 * A note, drawn. Its headings are each a heading of the section it is in
 * (`headingLevel`, h3 under a page's h2; h2 where the page has only an h1,
 * a link's): their size says their level, so the page's outline never
 * skips one.
 */
export function NoteText({ source, headingLevel = 3 }: { source: string; headingLevel?: 2 | 3 }) {
  const tree = useMemo(() => parseNotes(source), [source]);
  return (
    <div className="note">
      {tree.blocks.map((b, i) => (
        <Block key={i} block={b} headingLevel={headingLevel} />
      ))}
    </div>
  );
}

function Block({ block, headingLevel }: { block: NoteBlock; headingLevel: 2 | 3 }) {
  switch (block.type) {
    case 'heading': {
      // Level 3 is drawn as a note's only heading always was (5.35).
      const H = headingLevel === 2 ? 'h2' : 'h3';
      return <H className={`note-h note-h${block.level}`}>{inline(block.children)}</H>;
    }
    case 'paragraph':
      return <p>{inline(block.children)}</p>;
    case 'quote':
      return <blockquote className="note-quote">{inline(block.children)}</blockquote>;
    case 'list': {
      const checklist = block.items.some((item) => item.checked !== null);
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'note-check'}>
          {item.checked !== null && (
            <>
              <span className="note-box" aria-hidden="true">
                {item.checked ? '☑' : '☐'}
              </span>
              <span className="visually-hidden">{item.checked ? 'Done: ' : 'To do: '}</span>
            </>
          )}
          {inline(item.children)}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start}>{items}</ol>
      ) : (
        <ul className={checklist ? 'note-checklist' : undefined}>{items}</ul>
      );
    }
  }
}

/**
 * Where a link goes, as the browser will reach it: the URL parser's own
 * form — a host in another script as punycode, anything odd percent-encoded
 * — or null for an address it cannot open. What is shown is what is
 * followed.
 */
export function noteAddress(href: string): string | null {
  if (!noteLinkAllowed(href)) return null;
  try {
    return new URL(href).href;
  } catch {
    return null;
  }
}

/** A link's words, as the plain text of them. */
const wordsOf = (nodes: NoteInline[]) =>
  noteTreeText({ blocks: [{ type: 'paragraph', blankBefore: 0, children: nodes }] });

function inline(nodes: NoteInline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>;
      case 'break':
        return <br key={i} />;
      case 'strong':
        return <strong key={i}>{inline(node.children)}</strong>;
      case 'em':
        return <em key={i}>{inline(node.children)}</em>;
      case 'underline':
        return <u key={i}>{inline(node.children)}</u>;
      case 'strike':
        return <s key={i}>{inline(node.children)}</s>;
      case 'link': {
        // The parser makes no other link; asked again where it is drawn.
        const address = noteAddress(node.href);
        if (!address) {
          const words = wordsOf(node.children);
          return <Fragment key={i}>{words ? `${words} (${node.href})` : node.href}</Fragment>;
        }
        const words = node.children.length > 0 ? inline(node.children) : null;
        const web = /^https?:/i.test(address);
        // Each in an isolate, so neither the words nor anything around them
        // can reorder the address.
        return (
          <Fragment key={i}>
            <a href={address} rel="noopener noreferrer" {...(web ? { target: '_blank' } : {})}>
              {words ? <bdi>{words}</bdi> : <bdi dir="ltr">{address}</bdi>}
            </a>
            {words && (
              <span className="note-address">
                {' ('}
                <bdi dir="ltr">{address}</bdi>)
              </span>
            )}
          </Fragment>
        );
      }
    }
  });
}

// ---------------------------------------------------------------- writing

/**
 * Beside an Only me note's title (the N1 review): its words are sealed, its
 * title is not — so nothing of them is ever put in it unasked.
 */
export const ONLY_ME_TITLE =
  'Only the words of an Only me note are sealed, not its title: keep anything secret out of the title.';

const COUNT = new Intl.NumberFormat('en-GB');

/** "4,212 of 10,000 characters". */
const countOf = (n: number) => `${COUNT.format(n)} of ${COUNT.format(NOTES_MAX)} characters`;

/** The document as the vault holds it now: it sends it with a 409. */
export function heldNow(err: ApiRequestError): DocumentView | null {
  try {
    const doc = JSON.parse(err.detail ?? '') as Partial<DocumentView> | null;
    return doc && typeof doc.id === 'string' && typeof doc.etag === 'string'
      ? (doc as DocumentView)
      : null;
  } catch {
    return null;
  }
}

/**
 * What a note that looks as if it holds a password says, before it is
 * saved (0.9.0, N1): never refused — a note is not a password manager, and
 * the family can read and search one that is not Only me. The words of a
 * line are looked at as a tag's are (`looksSecret`): "wifi password: …",
 * "the PIN is 4821".
 */
export function secretNoteWarning(
  markdown: string,
  visibility: DocumentView['visibility'],
): string | null {
  const lines = notesPlainText(markdown.slice(0, 4_000)).split('\n').slice(0, 200);
  const found = lines.some((line) => looksSecret(line.slice(0, 80)));
  if (!found) return null;
  return visibility === 'private'
    ? 'This looks like a password or a PIN. A note is not a password manager: keep them in one if you can.'
    : 'This looks like a password or a PIN. Everyone who can see this note can read and search it: keep passwords and PINs in a password manager, or make the note Only me.';
}

/**
 * What a save that changed Sensitive says: and, made sensitive while links
 * outside the family still give it, that it is still shared and where to
 * end them.
 */
function sensitiveSaid(on: boolean, saved: DocumentView): string {
  const links = saved.warnings?.find((w) => w.code === 'sensitive_still_shared')?.links ?? 0;
  return [
    on ? 'This note is sensitive now.' : 'This note is not sensitive any more.',
    links > 0
      ? `It is still shared outside the family by ${links === 1 ? 'a link' : `${links} links`}: end ${links === 1 ? 'it' : 'them'} in Share a link if ${links === 1 ? 'it' : 'they'} should stop.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A note being written. */
interface Editing extends NoteDraft {
  /**
   * The ETag a save is sent with: the base's; a newer one whose note is the
   * one the edit began from (the document changed, not its note); or theirs,
   * once their note has been shown. Held here only, never in a draft.
   */
  sendEtag: string;
  /** Brought back from a draft kept before a reload. */
  restored: boolean;
  /** Their note, shown once the vault's is found to differ from the one this edit began from. */
  theirs: DocumentView | null;
  /** Whether anything was written since it began: a draft brought back was. */
  changed: boolean;
}

/** The note's words as the vault keeps them: '' for none. */
const wordsNow = (doc: Pick<DocumentView, 'notes'>) => doc.notes ?? '';

/** Whether this edit changed a note's title (one kept on its own): only then is it sent. */
const titleChanged = (e: Pick<NoteDraft, 'title' | 'baseTitle'>) =>
  e.title !== undefined && e.title.trim() !== (e.baseTitle ?? '').trim();

/**
 * Whether Sensitive was switched from what the note was as the edit began
 * (24 Nov 2026): only then is it sent, saved with the words.
 */
const sensitiveChanged = (e: Pick<NoteDraft, 'sensitive' | 'baseSensitive'>) =>
  e.sensitive !== undefined && e.sensitive !== (e.baseSensitive ?? false);

/**
 * Whether a draft holds anything the note does not: its words, its title or
 * its Sensitive changed. One that holds nothing is not brought back.
 */
const holdsChanges = (e: NoteDraft) =>
  e.text !== e.baseText || titleChanged(e) || sensitiveChanged(e);

/**
 * Somebody else's change met: their note's words, or — when this edit
 * changed the title too — its title, no longer what the edit began from
 * (the N1 review). Saving over either is a choice of its own.
 */
const changedMeanwhile = (doc: Pick<DocumentView, 'notes' | 'title'>, e: NoteDraft) =>
  wordsNow(doc) !== e.baseText || (titleChanged(e) && (doc.title ?? '') !== (e.baseTitle ?? ''));

/**
 * A draft brought back, held to the document as it is now: its note still
 * the one the draft began from, it carries on from the document now; else
 * their note is shown, and nothing is saved over it unasked (the 5.35
 * review, W535-03).
 */
function fromDraft(doc: DocumentView, kept: NoteDraft): Editing {
  const same = doc.etag === kept.baseEtag || !changedMeanwhile(doc, kept);
  return {
    ...kept,
    sendEtag: doc.etag,
    restored: true,
    theirs: same ? null : doc,
    changed: true,
  };
}

/**
 * A note's section: the note as it reads, who last changed it and when (on
 * the household's clock), and — for whoever may change it — Edit, the
 * editor, Save and Cancel.
 *
 * As a document's (`variant: 'document'`, 5.35): under its own heading,
 * "Add a note" or "Edit note". As a note kept on its own (`'note'`, 0.9.0,
 * N1): the note itself, its title written with its words, under the
 * screen's own heading (`labelledBy`).
 *
 * Saving is made from the note the edit began from (the 5.35 review, A535-01,
 * W535-01, W535-03, W535-04). The document's ETag moves whenever anything
 * of it changes — a new version, who can see it, its name — so a save the
 * vault refuses (409) is looked at: when the note is still the one this
 * edit began from, it is saved again, once, quietly, from the document as
 * it is now; only when the note itself is somebody else's is it shown, with
 * who changed it, and saving over it is a choice of its own. Either way
 * the page is given the document as it is now.
 */
export function NotesSection(props: {
  doc: DocumentView;
  /** The type's own word for notes, or "Notes"; for a note kept on its own, "Note". */
  label: string;
  /** Whoever may change the document: never a viewer or a guest; a teen, their own. */
  mayEdit: boolean;
  /** The household's time zone, which "edited …" is said in. */
  timezone: string | null;
  onSaved: (doc: DocumentView) => void;
  /** A save was refused (409): the document as the vault holds it now. */
  onRefreshed: (doc: DocumentView) => void;
  /** A document's note (5.35), or a note kept on its own (0.9.0, N1). */
  variant?: 'document' | 'note';
  /** A note kept on its own: the heading its section is named by. */
  labelledBy?: string;
  /** Told whether there is anything unsaved, as it changes. */
  onDirty?: (dirty: boolean) => void;
  /**
   * A note kept on its own: where its Edit button goes — beside the note's
   * title, on the same line — rather than above its words.
   */
  editSlot?: HTMLElement | null;
  /**
   * Its words withheld until it is confirmed to be you (0.9.0-dev.87): asked
   * again, rather than an editor begun with nothing in it.
   */
  onConfirm?: () => void;
  /**
   * A note kept on its own, where the vault offers Sensitive: its switch at
   * the end of the Save and Cancel row while it is written (the owner's
   * request of 24 Nov 2026), saved with the words. A teen may make a note
   * sensitive, never not.
   */
  sensitiveOffered?: boolean;
}) {
  const { doc, mayEdit } = props;
  const variant = props.variant ?? 'document';
  const own = variant === 'note';
  const { guarded, session } = useApp();
  const info = session.info;
  // Sensitive, for a note kept on its own where the vault offers it: as
  // the note is now, and whether a teen must keep it so.
  const sensitiveNow = doc.sensitive_effective === true;
  const sensitiveShown = own && props.sensitiveOffered === true;
  const teenKeeps = (info?.role ?? storedRole()) === 'teen' && sensitiveNow;
  const householdId = info?.household_id ?? null;
  const memberId = info?.member_id ?? null;
  const who: DraftOwner | null =
    householdId && memberId ? { household_id: householdId, member_id: memberId } : null;
  const id = useId();
  const named = useNamedWithin();
  // A draft kept from before a reload opens the editor with it (A32).
  const [editing, setEditing] = useState<Editing | null>(() => {
    const kept = mayEdit && who ? draftOf(doc, who) : null;
    // Nothing in it the note does not have: no draft to bring back.
    if (kept && who && !holdsChanges(kept)) forgetDraft(doc.id, who);
    return kept && holdsChanges(kept) ? fromDraft(doc, kept) : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What a save of Sensitive came to: said once the editor has gone.
  const [said, setSaid] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const conflict = useRef<HTMLParagraphElement>(null);
  /** Where focus goes once the editor has gone. */
  const back = useRef(false);
  /** The newest the page knows of the document: what a draft is kept for. */
  const known = useRef(doc);

  // The page loaded the document again — after a new version, a change of
  // who can see it, a detail removed — while the note was being written:
  // still the note this edit began from, it carries on from the document
  // now; somebody else's, it is shown (the 5.35 review, A535-01, W535-04).
  const [seen, setSeen] = useState(doc);
  if (seen !== doc) {
    setSeen(doc);
    if (editing && doc.etag !== editing.sendEtag) {
      setEditing({
        ...editing,
        sendEtag: doc.etag,
        theirs: changedMeanwhile(doc, editing) ? doc : editing.theirs,
      });
    }
  }

  useLayoutEffect(() => {
    known.current = doc;
  });

  // Anything unsaved, said to the page as it changes.
  const dirty = editing !== null && editing.changed;
  const { onDirty } = props;
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  // A tab closed or reloaded with something unsaved is asked about first.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  // A document no longer for everyone keeps no draft, however that is
  // learnt: the page, or a refused save; nor one made Essential
  // (0.9.0-dev.87), whose words ask to confirm it's you.
  const draftsKept = keepsDrafts(doc);
  useEffect(() => {
    if (householdId && memberId && !draftsKept) {
      forgetDraft(doc.id, { household_id: householdId, member_id: memberId });
    }
  }, [doc.id, draftsKept, householdId, memberId]);

  useEffect(() => {
    if (editing || !back.current) return;
    back.current = false;
    opener.current?.focus();
  }, [editing]);

  // Somebody else's note found: focus goes to what says so.
  const theirs = editing?.theirs ?? null;
  useEffect(() => {
    if (theirs) conflict.current?.focus();
  }, [theirs]);

  /** A draft of this, kept — only for a document everyone in the family sees. */
  const persist = (e: Editing) => {
    if (!who) return;
    const draft: NoteDraft = {
      text: e.text,
      baseText: e.baseText,
      baseEtag: e.baseEtag,
      baseStamp: e.baseStamp,
      ...(e.title !== undefined ? { title: e.title, baseTitle: e.baseTitle ?? '' } : {}),
      ...(e.sensitive !== undefined ? { sensitive: e.sensitive } : {}),
      ...(e.baseSensitive !== undefined ? { baseSensitive: e.baseSensitive } : {}),
    };
    // Nothing changed after all: no draft to come back to after a reload.
    if (holdsChanges(draft)) keepDraft(known.current, who, draft);
    else forgetDraft(doc.id, who);
  };

  const write = (change: { text?: string; title?: string; sensitive?: boolean }) => {
    setEditing((was) => {
      if (!was) return was;
      const next = { ...was, ...change, changed: true };
      // Switched back to how it began: no change of Sensitive to send.
      if (change.sensitive !== undefined && change.sensitive === (was.baseSensitive ?? false)) {
        delete next.sensitive;
      }
      persist(next);
      return next;
    });
  };

  const start = () => {
    setError(null);
    setSaid(null);
    const text = wordsNow(doc);
    setEditing({
      text,
      baseText: text,
      baseEtag: doc.etag,
      baseStamp: doc.notes_updated_at ?? null,
      ...(own ? { title: doc.title ?? '', baseTitle: doc.title ?? '' } : {}),
      ...(own ? { baseSensitive: doc.sensitive_effective === true } : {}),
      sendEtag: doc.etag,
      restored: false,
      theirs: null,
      changed: false,
    });
  };

  const close = () => {
    if (who) forgetDraft(doc.id, who);
    setEditing(null);
    setError(null);
    back.current = true;
  };

  const save = async () => {
    if (!editing || busy) return;
    const began = editing;
    // What is sent is what the page shows: the words as they read back.
    const notes = began.text.trim() || null;
    // The title only when this edit changed it: never somebody else's,
    // renamed meanwhile, put back by a save of the words (the N1 review).
    const title = own && titleChanged(began) ? (began.title ?? '').trim() || null : undefined;
    // Sensitive only when this edit switched it from how the note was as
    // it began, and the note is not so already — never somebody else's
    // change put back by a switch left alone — and never made not
    // sensitive by a teen: saved with the words, in the same save.
    const sensitiveFor = (current: DocumentView): boolean | undefined => {
      if (!sensitiveShown || !sensitiveChanged(began)) return undefined;
      const isNow = current.sensitive_effective === true;
      if (began.sensitive === isNow) return undefined;
      if (began.sensitive === false && (info?.role ?? storedRole()) === 'teen') return undefined;
      return began.sensitive;
    };
    let current = doc;
    setBusy(true);
    setError(null);
    let etag = began.sendEtag;
    try {
      for (let tries = 0; tries < 2; tries++) {
        try {
          // An Only me or an Essential note asks to confirm it's you first,
          // once in five minutes (0.9.0-dev.87); cancelled, nothing is saved,
          // and the words stay in the editor.
          const sensitive = sensitiveFor(current);
          const saved = await guarded((t) =>
            api.updateDocument(
              t,
              doc.id,
              {
                notes,
                ...(title !== undefined ? { title } : {}),
                ...(sensitive !== undefined ? { sensitive } : {}),
              },
              etag,
            ),
          );
          if (!saved) return;
          close();
          props.onSaved(saved);
          if (sensitive !== undefined) setSaid(sensitiveSaid(sensitive, saved));
          return;
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
          const now = heldNow(err);
          if (!now) {
            setError(
              'Someone else changed this note while you were writing. Your draft is still here: copy it, then reload the page to see theirs.',
            );
            return;
          }
          // The page shows the document as it is now: Keep theirs shows
          // theirs, and an edit begins from it. No draft is kept of a note
          // on a document no longer for everyone (A32).
          known.current = now;
          props.onRefreshed(now);
          if (who && !keepsDrafts(now)) forgetDraft(doc.id, who);
          if (changedMeanwhile(now, began)) {
            setEditing((e) => e && { ...e, sendEtag: now.etag, theirs: now });
            return;
          }
          // The document changed, not its note: saved again from it, once.
          etag = now.etag;
          current = now;
          setEditing((e) => e && { ...e, sendEtag: now.etag });
        }
      }
      setError('This note changed again as it was saved. Save it once more.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const stamp =
    doc.notes && doc.notes_updated_at
      ? `edited ${exactWords(doc.notes_updated_at, props.timezone ?? undefined)}${
          doc.notes_updated_by_name ? ` by ${doc.notes_updated_by_name}` : ''
        }`
      : null;
  const headingId = `${id}-h`;
  // Named only when the note itself changed since the edit began.
  const changedBy =
    theirs &&
    editing &&
    theirs.notes_updated_at &&
    theirs.notes_updated_at !== editing.baseStamp &&
    theirs.notes_updated_by_name
      ? theirs.notes_updated_by_name
      : 'Someone else';
  const tooLong = editing !== null && editing.text.length > NOTES_MAX;
  const sensitiveSwitched = editing?.sensitive ?? sensitiveNow;
  const secret = editing ? secretNoteWarning(editing.text, doc.visibility) : null;

  // Its words withheld (0.9.0-dev.87): never an editor begun with nothing
  // in it, whose save would put nothing over them.
  const withheld = doc.confirm_to_read !== undefined && doc.notes === null;
  const editButton =
    mayEdit && !editing && !withheld ? (
      <Button kind={own ? 'primary' : 'quiet'} ref={opener} onClick={start}>
        {own ? 'Edit' : doc.notes ? 'Edit note' : 'Add a note'}
      </Button>
    ) : null;

  return (
    <section
      aria-labelledby={own ? props.labelledBy : named(headingId)}
      className={own ? 'notes notes-own' : 'notes'}
    >
      {own && props.editSlot
        ? editButton && createPortal(editButton, props.editSlot)
        : (editButton || !own) && (
            <div className="notes-head">
              {!own && (
                <h2 id={headingId} className="section-h">
                  {props.label}
                </h2>
              )}
              {editButton}
            </div>
          )}
      {!editing && doc.notes && <NoteText source={doc.notes} />}
      {!editing && withheld && (
        <div className="stack">
          <p>{NOTE_ASKS}</p>
          {props.onConfirm && (
            <div className="row">
              <Button onClick={props.onConfirm}>Confirm it’s you</Button>
            </div>
          )}
        </div>
      )}
      {!editing && own && !doc.notes && !withheld && (
        <p className="muted">Nothing written in it yet.</p>
      )}
      {!editing && stamp && !own && <p className="muted note-stamp">{stamp}</p>}
      {editing && (
        <div className="note-editor">
          {editing.restored && (
            <p className="muted" role="status">
              Your unsaved draft of this note is back.
            </p>
          )}
          {theirs && (
            <div className="note-conflict" role="group" aria-labelledby={`${id}-conflict`}>
              <p id={`${id}-conflict`} ref={conflict} tabIndex={-1}>
                {changedBy} changed this note while you were writing. Your draft is still here, and
                theirs is below.
              </p>
              {own && (theirs.title ?? '') !== (editing.baseTitle ?? '') && (
                <p>
                  Their title: <strong>{theirs.title ?? 'none'}</strong>
                </p>
              )}
              {theirs.notes ? (
                <NoteText source={theirs.notes} />
              ) : (
                <p className="muted">They took the note off.</p>
              )}
              <div className="row">
                <Button onClick={() => void save()} disabled={busy || tooLong}>
                  {busy ? 'Saving…' : 'Save mine over theirs'}
                </Button>
                <Button kind="quiet" onClick={close} disabled={busy}>
                  Keep theirs
                </Button>
              </div>
            </div>
          )}
          {own && (
            <div className="field">
              <label htmlFor={`${id}-title`}>Title</label>
              <input
                id={`${id}-title`}
                type="text"
                value={editing.title ?? ''}
                maxLength={200}
                aria-describedby={doc.visibility === 'private' ? `${id}-title-note` : undefined}
                onChange={(e) => write({ title: e.target.value })}
              />
              {doc.visibility === 'private' && (
                <span id={`${id}-title-note`} className="muted field-note">
                  {ONLY_ME_TITLE}
                </span>
              )}
            </div>
          )}
          <RichTextEditor
            label={props.label}
            initial={editing.text}
            autoFocus={!own}
            describedBy={`${id}-count${secret ? ` ${id}-secret` : ''}`}
            onChange={(text) => write({ text })}
          />
          <p
            id={`${id}-count`}
            className={`note-count ${tooLong ? 'field-error' : 'muted'}`}
            {...(tooLong ? { role: 'alert' } : {})}
          >
            {tooLong
              ? `Too long to save: ${countOf(editing.text.length)}.`
              : countOf(editing.text.length)}
          </p>
          {secret && (
            <p id={`${id}-secret`} className="note-secret" role="status">
              {secret}
            </p>
          )}
          <ErrorNote message={error} />
          {/* Saving over somebody else's note is the choice above, not this. */}
          {!theirs && (
            <div className="row note-save-row">
              <Button onClick={() => void save()} disabled={busy || tooLong}>
                {busy ? 'Saving…' : own ? 'Save' : 'Save note'}
              </Button>
              <Button kind="quiet" onClick={close} disabled={busy}>
                Cancel
              </Button>
              {/* Sensitive, at the row's far end: saved with Save, put back by Cancel. */}
              {sensitiveShown && (
                <span className="note-sensitive" title={SENSITIVE_MEANS}>
                  {teenKeeps ? (
                    <span className="muted">
                      {SENSITIVE_LABEL}. {TEEN_KEEPS_SENSITIVE}
                    </span>
                  ) : (
                    <Switch
                      id={`${id}-sensitive`}
                      label={SENSITIVE_LABEL}
                      word={SENSITIVE_LABEL}
                      checked={sensitiveSwitched}
                      onChange={(on) => write({ sensitive: on })}
                    />
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {own && (
        <>
          {/* The note's words above, what the vault says of it below. */}
          <hr className="note-divider" />
          {!editing && stamp && <p className="muted note-stamp">{stamp}</p>}
          <p className="muted" role="status">
            {said}
          </p>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------- Essential and Sensitive

/**
 * A note as an answer gives it, its words kept from the copy in hand where
 * the answer withholds them (0.9.0-dev.87): a change to a note made Essential
 * just now, say, is answered without its words, which the page has already.
 */
export function keepWords(had: DocumentView, next: DocumentView): DocumentView {
  if (next.notes !== null || !next.confirm_to_read || had.notes === null) return next;
  const { confirm_to_read: _withheld, ...rest } = next;
  void _withheld;
  return {
    ...rest,
    notes: had.notes,
    ...(had.note_name !== undefined ? { note_name: had.note_name } : {}),
  };
}

/** Said where an Only me or an Essential note waits to be confirmed (0.9.0-dev.87). */
export const NOTE_ASKS = 'This note asks you to confirm it’s you before its words are shown.';

/** What Essential means for a note, said where it is chosen (0.9.0-dev.87). */
export const ESSENTIAL_NOTE_MEANS =
  'An Essential note asks you to confirm it’s you before its words are shown, and the family’s phones can keep it for when there is no connection.';
