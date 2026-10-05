import {
  noteLinkAllowed,
  NOTES_MAX,
  noteTreeText,
  parseNotes,
  whenExactly,
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
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp } from './app-context.js';
import { draftOf, forgetDraft, keepDraft, type DraftOwner, type NoteDraft } from './note-drafts.js';
import { Button, ErrorNote } from './ui.js';

/**
 * A document's note on the web (5.35, A30): read by whoever sees the
 * document, written by whoever may change it. One note a document.
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

/** A note, drawn. */
export function NoteText({ source }: { source: string }) {
  const tree = useMemo(() => parseNotes(source), [source]);
  return (
    <div className="note">
      {tree.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

function Block({ block }: { block: NoteBlock }) {
  switch (block.type) {
    case 'heading':
      return <h3 className="note-h">{inline(block.children)}</h3>;
    case 'paragraph':
      return <p>{inline(block.children)}</p>;
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

export type NoteFormat = 'bold' | 'italic' | 'list' | 'numbered' | 'checklist' | 'link';

/** A link's address until the person types theirs over it: one the parser takes as a link. */
export const LINK_PLACEHOLDER = 'https://example.com';

/** A list's or a heading's marker at the start of a line, and the spaces before it. */
const BLOCK_MARK = /^[ \t]*(?:[-*+] \[[ xX]\] |[-*+] |\d{1,9}\. |### )?/;
/** Any list marker a line already has, which a list button replaces. */
const LIST_MARK = /^[ \t]*(?:[-*+] \[[ xX]\] |[-*+] |\d{1,9}\. )?/;

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The word the caret is in or beside, as its start and end; the caret itself when in none. */
function wordAround(text: string, at: number): [number, number] {
  let a = at;
  let b = at;
  while (a > 0 && isWordChar(text[a - 1])) a -= 1;
  while (b < text.length && isWordChar(text[b])) b += 1;
  return [a, b];
}

/**
 * One line's part of a choice, split into what stays outside the marks —
 * the spaces round it, and a list's or heading's marker when the part
 * starts its line — and the words the marks go round.
 */
function partsOf(text: string, from: number, to: number) {
  const part = text.slice(from, to);
  const atLineStart = from === 0 || text[from - 1] === '\n';
  const lead = atLineStart
    ? (BLOCK_MARK.exec(part)?.[0] ?? '')
    : part.slice(0, part.length - part.trimStart().length);
  const rest = part.slice(lead.length);
  const words = rest.trimEnd();
  return { lead, words, trail: rest.slice(words.length) };
}

/**
 * What a toolbar button does to what is being written, so the note reads
 * as the button meant (the 5.35 review, W535-05): the words chosen made
 * bold or italic — the spaces round them, and a line's list marker, left
 * outside the marks; each line on its own, since marks do not run across
 * lines; with `*`, which works inside a word; with nothing chosen, the word
 * the caret is in, or a word to type over — or made a link to an address to
 * type over; or the lines chosen made a list, any marker they had replaced
 * and blank lines left blank. Answers the new text and what to choose in it
 * next.
 */
export function formatNote(
  text: string,
  start: number,
  end: number,
  format: NoteFormat,
): { text: string; start: number; end: number } {
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  if (format === 'bold' || format === 'italic') {
    const mark = format === 'bold' ? '**' : '*';
    if (s === e) [s, e] = wordAround(text, s);
    if (s === e) {
      // Nothing to mark: a word to type over, chosen.
      const word = format;
      return {
        text: `${text.slice(0, s)}${mark}${word}${mark}${text.slice(e)}`,
        start: s + mark.length,
        end: s + mark.length + word.length,
      };
    }
    let out = '';
    let first: [number, number] | null = null;
    let from = s;
    while (from <= e) {
      const nl = text.indexOf('\n', from);
      const to = nl === -1 || nl > e ? e : nl;
      const { lead, words, trail } = partsOf(text, from, to);
      if (words) {
        const at = s + out.length + lead.length + mark.length;
        first ??= [at, at + words.length];
        out += `${lead}${mark}${words}${mark}${trail}`;
      } else {
        out += `${lead}${trail}`;
      }
      if (to === e) break;
      out += '\n';
      from = to + 1;
    }
    const one = !text.slice(s, e).includes('\n');
    return {
      text: `${text.slice(0, s)}${out}${text.slice(e)}`,
      start: one && first ? first[0] : s,
      end: one && first ? first[1] : s + out.length,
    };
  }
  if (format === 'link') {
    // One link: the first line of what is chosen, or the word at the caret.
    if (s === e) [s, e] = wordAround(text, s);
    const nl = text.indexOf('\n', s);
    if (nl !== -1 && nl < e) e = nl;
    const { lead, words, trail } = partsOf(text, s, e);
    // A bracket would end the link's words early: shown as the parenthesis it reads as.
    const label = (words || 'link').replace(/\[/g, '(').replace(/\]/g, ')');
    const linked = `${lead}[${label}](${LINK_PLACEHOLDER})${trail}`;
    const address = s + lead.length + label.length + 3;
    return {
      text: `${text.slice(0, s)}${linked}${text.slice(e)}`,
      start: address,
      end: address + LINK_PLACEHOLDER.length,
    };
  }
  // A list: every line the choice touches. Blank ones in a choice of
  // several stay blank; a blank line the caret is on becomes an empty item.
  const from = s === 0 ? 0 : text.lastIndexOf('\n', s - 1) + 1;
  const last = e > s && text[e - 1] === '\n' ? e - 1 : e;
  const found = text.indexOf('\n', last);
  const to = found === -1 ? text.length : found;
  const lines = text.slice(from, to).split('\n');
  let n = 0;
  const marked = lines
    .map((line) => {
      if (lines.length > 1 && line.trim() === '') return line;
      n += 1;
      const mark = format === 'numbered' ? `${n}. ` : format === 'checklist' ? '- [ ] ' : '- ';
      return mark + line.replace(LIST_MARK, '');
    })
    .join('\n');
  return {
    text: `${text.slice(0, from)}${marked}${text.slice(to)}`,
    start: from + marked.length,
    end: from + marked.length,
  };
}

const TOOLS: Array<{ format: NoteFormat; label: string; keys?: string }> = [
  { format: 'bold', label: 'Bold', keys: 'Control+B' },
  { format: 'italic', label: 'Italic', keys: 'Control+I' },
  { format: 'list', label: 'List' },
  { format: 'numbered', label: 'Numbered' },
  { format: 'checklist', label: 'Checklist' },
  { format: 'link', label: 'Link' },
];

/** "4,212 of 10,000 characters". */
const countOf = (n: number) =>
  `${n.toLocaleString('en-GB')} of ${NOTES_MAX.toLocaleString('en-GB')} characters`;

/** The document as the vault holds it now: it sends it with a 409. */
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
}

/** The note's words as the vault keeps them: '' for none. */
const wordsNow = (doc: Pick<DocumentView, 'notes'>) => doc.notes ?? '';

/**
 * A draft brought back, held to the document as it is now: its note still
 * the one the draft began from, it carries on from the document now; else
 * their note is shown, and nothing is saved over it unasked (the 5.35
 * review, W535-03).
 */
function fromDraft(doc: DocumentView, kept: NoteDraft): Editing {
  const same = doc.etag === kept.baseEtag || wordsNow(doc) === kept.baseText;
  return { ...kept, sendEtag: doc.etag, restored: true, theirs: same ? null : doc };
}

/**
 * A document's Notes section: the note as it reads, who last changed it and
 * when (on the household's clock), and — for whoever may change the
 * document — Add a note or Edit note.
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
  /** The type's own word for notes, or "Notes". */
  label: string;
  /** Whoever may change the document: never a viewer or a guest; a teen, their own. */
  mayEdit: boolean;
  /** The household's time zone, which "edited …" is said in. */
  timezone: string | null;
  onSaved: (doc: DocumentView) => void;
  /** A save was refused (409): the document as the vault holds it now. */
  onRefreshed: (doc: DocumentView) => void;
}) {
  const { doc, mayEdit } = props;
  const { withToken, session } = useApp();
  const info = session.info;
  const householdId = info?.household_id ?? null;
  const memberId = info?.member_id ?? null;
  const who: DraftOwner | null =
    householdId && memberId ? { household_id: householdId, member_id: memberId } : null;
  const id = useId();
  // A draft kept from before a reload opens the editor with it (A32).
  const [editing, setEditing] = useState<Editing | null>(() => {
    const kept = mayEdit && who ? draftOf(doc, who) : null;
    return kept ? fromDraft(doc, kept) : null;
  });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const conflict = useRef<HTMLParagraphElement>(null);
  /** What to choose in the box once React has put the new text in it. */
  const choose = useRef<[number, number] | null>(null);
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
        theirs: wordsNow(doc) === editing.baseText ? editing.theirs : doc,
      });
    }
  }

  useLayoutEffect(() => {
    known.current = doc;
  });

  // A document no longer for everyone keeps no draft (A32), however that
  // is learnt: the page, or a refused save (the 5.35 review, W535-02).
  useEffect(() => {
    if (householdId && memberId && doc.visibility !== 'household') {
      forgetDraft(doc.id, { household_id: householdId, member_id: memberId });
    }
  }, [doc.id, doc.visibility, householdId, memberId]);

  useLayoutEffect(() => {
    const at = choose.current;
    if (!at || !box.current) return;
    choose.current = null;
    box.current.focus();
    box.current.setSelectionRange(at[0], at[1]);
  });

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
    keepDraft(known.current, who, {
      text: e.text,
      baseText: e.baseText,
      baseEtag: e.baseEtag,
      baseStamp: e.baseStamp,
    });
  };

  const write = (text: string) => {
    if (!editing) return;
    const next = { ...editing, text };
    setEditing(next);
    persist(next);
  };

  const start = () => {
    setError(null);
    setPreview(false);
    const text = wordsNow(doc);
    setEditing({
      text,
      baseText: text,
      baseEtag: doc.etag,
      baseStamp: doc.notes_updated_at ?? null,
      sendEtag: doc.etag,
      restored: false,
      theirs: null,
    });
    choose.current = [text.length, text.length];
  };

  const close = () => {
    if (who) forgetDraft(doc.id, who);
    setEditing(null);
    setError(null);
    back.current = true;
  };

  const format = (f: NoteFormat) => {
    if (!editing || !box.current) return;
    const { selectionStart, selectionEnd } = box.current;
    const next = formatNote(editing.text, selectionStart, selectionEnd, f);
    // Over the limit, it is not done: the box would cut the note short.
    if (next.text.length > NOTES_MAX) return;
    choose.current = [next.start, next.end];
    write(next.text);
  };

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'b' && k !== 'i') return;
    e.preventDefault();
    format(k === 'b' ? 'bold' : 'italic');
  };

  const save = async () => {
    if (!editing || busy) return;
    const began = editing;
    // What is sent is what the preview shows.
    const notes = began.text.trim() || null;
    setBusy(true);
    setError(null);
    let etag = began.sendEtag;
    try {
      for (let tries = 0; tries < 2; tries++) {
        try {
          const saved = await withToken((t) => api.updateDocument(t, doc.id, { notes }, etag));
          if (!saved) return;
          close();
          props.onSaved(saved);
          return;
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
          const now = heldNow(err);
          if (!now) {
            setError(
              'Someone else changed this document while you were writing. Your draft is still here: copy it, then reload the page to see theirs.',
            );
            return;
          }
          // The page shows the document as it is now: Keep theirs shows
          // theirs, and an edit begins from it. No draft is kept of a note
          // on a document no longer for everyone (A32).
          known.current = now;
          props.onRefreshed(now);
          if (who && now.visibility !== 'household') forgetDraft(doc.id, who);
          if (wordsNow(now) !== began.baseText) {
            setEditing((e) => e && { ...e, sendEtag: now.etag, theirs: now });
            return;
          }
          // The document changed, not its note: saved again from it, once.
          etag = now.etag;
          setEditing((e) => e && { ...e, sendEtag: now.etag });
        }
      }
      setError('This document changed again as the note was saved. Save it once more.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const stamp =
    doc.notes && doc.notes_updated_at
      ? `edited ${whenExactly(doc.notes_updated_at, props.timezone)}${
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

  return (
    <section aria-labelledby={headingId} className="notes">
      <div className="notes-head">
        <h2 id={headingId} className="section-h">
          {props.label}
        </h2>
        {mayEdit && !editing && (
          <Button kind="quiet" ref={opener} onClick={start}>
            {doc.notes ? 'Edit note' : 'Add a note'}
          </Button>
        )}
      </div>
      {!editing && doc.notes && <NoteText source={doc.notes} />}
      {!editing && stamp && <p className="muted note-stamp">{stamp}</p>}
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
              {theirs.notes ? (
                <NoteText source={theirs.notes} />
              ) : (
                <p className="muted">They took the note off.</p>
              )}
              <div className="row">
                <Button onClick={() => void save()} disabled={busy}>
                  {busy ? 'Saving…' : 'Save mine over theirs'}
                </Button>
                <Button kind="quiet" onClick={close} disabled={busy}>
                  Keep theirs
                </Button>
              </div>
            </div>
          )}
          <div className="pills" role="group" aria-label="Write or preview">
            {[false, true].map((p) => (
              <button
                key={String(p)}
                type="button"
                className={`pill${preview === p ? ' pill-on' : ''}`}
                aria-pressed={preview === p}
                onClick={() => setPreview(p)}
              >
                {p ? 'Preview' : 'Write'}
              </button>
            ))}
          </div>
          {preview ? (
            <div className="note-preview" role="region" aria-label="Preview of the note">
              {/* What Save sends: the note trimmed (the 5.35 review, W535-08). */}
              {editing.text.trim() ? (
                <NoteText source={editing.text.trim()} />
              ) : (
                <p className="muted">Nothing written yet.</p>
              )}
            </div>
          ) : (
            <>
              <div className="note-tools" role="group" aria-label="Formatting">
                {TOOLS.map((t) => (
                  <button
                    key={t.format}
                    type="button"
                    className="btn btn-quiet note-tool"
                    aria-keyshortcuts={t.keys}
                    onClick={() => format(t.format)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <label htmlFor={`${id}-text`} className="visually-hidden">
                {props.label}
              </label>
              <textarea
                id={`${id}-text`}
                ref={box}
                className="note-input"
                value={editing.text}
                rows={8}
                maxLength={NOTES_MAX}
                aria-describedby={`${id}-help ${id}-count`}
                onKeyDown={keys}
                onChange={(e) => write(e.target.value)}
              />
              <p id={`${id}-help`} className="muted note-help">
                **bold**, *italic*, “- ” a list, “1. ” numbered, “- [ ] ” a checklist, “### ” a
                heading, [words](https://…) a link.
              </p>
            </>
          )}
          <p id={`${id}-count`} className="muted note-count">
            {countOf(editing.text.length)}
          </p>
          <ErrorNote message={error} />
          {/* Saving over somebody else's note is the choice above, not this. */}
          {!theirs && (
            <div className="row">
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save note'}
              </Button>
              <Button kind="quiet" onClick={close} disabled={busy}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
