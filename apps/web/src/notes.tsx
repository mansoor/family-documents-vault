import {
  noteLinkAllowed,
  NOTES_MAX,
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
import { draftOf, forgetDraft, keepDraft } from './note-drafts.js';
import { Button, ErrorNote } from './ui.js';

/**
 * A document's note on the web (5.35, A30): read by whoever sees the
 * document, written by whoever may change it. One note a document.
 *
 * A note is drawn from the tree `@fdv/shared` reads it into, as React
 * elements, and never as an HTML string: whatever somebody types — a
 * `<script>`, an image, a `javascript:` link — is shown as the characters it
 * is. A link goes only to https, http or mailto, opens with
 * `rel="noopener noreferrer"`, and shows its address beside its words.
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

/** Where a link goes, as the note shows it: an email's address without its `mailto:`. */
const addressOf = (href: string) => (/^mailto:/i.test(href) ? href.slice(7) : href);

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
        if (!noteLinkAllowed(node.href)) return <Fragment key={i}>{node.href}</Fragment>;
        const words = node.children.length > 0 ? inline(node.children) : null;
        const web = /^https?:/i.test(node.href);
        return (
          <Fragment key={i}>
            <a href={node.href} rel="noopener noreferrer" {...(web ? { target: '_blank' } : {})}>
              {words ?? addressOf(node.href)}
            </a>
            {words && <span className="note-address"> ({addressOf(node.href)})</span>}
          </Fragment>
        );
      }
    }
  });
}

// ---------------------------------------------------------------- writing

export type NoteFormat = 'bold' | 'italic' | 'list' | 'numbered' | 'checklist' | 'link';

/**
 * What a toolbar button does to what is being written: the words chosen
 * made bold, italic or a link, or the lines chosen made a list. Answers the
 * new text and what to choose in it next.
 */
export function formatNote(
  text: string,
  start: number,
  end: number,
  format: NoteFormat,
): { text: string; start: number; end: number } {
  const before = text.slice(0, start);
  const chosen = text.slice(start, end);
  const after = text.slice(end);
  switch (format) {
    case 'bold':
    case 'italic': {
      const mark = format === 'bold' ? '**' : '*';
      return {
        text: `${before}${mark}${chosen}${mark}${after}`,
        start: start + mark.length,
        end: end + mark.length,
      };
    }
    case 'link': {
      // The words chosen (or "link") go to an address, chosen next to type over.
      const words = chosen || 'link';
      const address = before.length + words.length + 3;
      return {
        text: `${before}[${words}](https://)${after}`,
        start: address,
        end: address + 'https://'.length,
      };
    }
    default: {
      // Every line the choice touches, marked.
      const from = text.lastIndexOf('\n', start - 1) + 1;
      const found = text.indexOf('\n', Math.max(end - (end > start ? 1 : 0), start));
      const to = found === -1 ? text.length : found;
      const lines = text.slice(from, to).split('\n');
      const marked = lines
        .map((line, i) =>
          format === 'numbered'
            ? `${i + 1}. ${line}`
            : format === 'checklist'
              ? `- [ ] ${line}`
              : `- ${line}`,
        )
        .join('\n');
      return {
        text: `${text.slice(0, from)}${marked}${text.slice(to)}`,
        start: from + marked.length,
        end: from + marked.length,
      };
    }
  }
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

/**
 * A document's Notes section: the note as it reads, who last changed it and
 * when (on the household's clock), and — for whoever may change the
 * document — Add a note or Edit note.
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
}) {
  const { doc, mayEdit } = props;
  const { withToken } = useApp();
  const id = useId();
  // A draft kept from before a reload opens the editor with it (A32).
  const [editing, setEditing] = useState<{ text: string; etag: string; restored: boolean } | null>(
    () => {
      const kept = mayEdit ? draftOf(doc) : null;
      return kept ? { ...kept, restored: true } : null;
    },
  );
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Saved meanwhile by somebody else: their note, shown under the draft that is kept. */
  const [theirs, setTheirs] = useState<DocumentView | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** What to choose in the box once React has put the new text in it. */
  const choose = useRef<[number, number] | null>(null);
  /** Where focus goes once the editor has gone. */
  const back = useRef(false);

  // A document no longer for everyone keeps no draft (A32): draftOf forgets it.
  useEffect(() => {
    if (doc.visibility !== 'household') forgetDraft(doc.id);
  }, [doc.id, doc.visibility]);

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

  const write = (text: string, etag: string) => {
    setEditing((e) => ({ text, etag, restored: e?.restored ?? false }));
    keepDraft(doc, { text, etag });
  };

  const start = () => {
    setError(null);
    setTheirs(null);
    setPreview(false);
    const text = doc.notes ?? '';
    setEditing({ text, etag: doc.etag, restored: false });
    choose.current = [text.length, text.length];
  };

  const close = () => {
    forgetDraft(doc.id);
    setEditing(null);
    setTheirs(null);
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
    write(next.text, editing.etag);
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
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) =>
        api.updateDocument(t, doc.id, { notes: editing.text.trim() || null }, editing.etag),
      );
      if (!saved) return;
      close();
      props.onSaved(saved);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // Somebody else saved first: theirs is shown, and the draft is kept.
        // Saving again is saving over theirs, knowingly.
        const now = heldNow(err);
        if (now) {
          setTheirs(now);
          write(editing.text, now.etag);
        } else {
          setError(
            'Someone else changed this document while you were writing. Your draft is still here: copy it, then reload the page to see theirs.',
          );
        }
      } else {
        setError(describeError(err));
      }
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
            <div className="note-conflict" role="alert">
              <p>
                {theirs.notes_updated_by_name ?? 'Someone else'} changed this note while you were
                writing. Your draft is still here. Theirs is below: save again to replace it with
                yours, or cancel to keep theirs.
              </p>
              {theirs.notes ? (
                <NoteText source={theirs.notes} />
              ) : (
                <p className="muted">They took the note off.</p>
              )}
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
              {editing.text.trim() ? (
                <NoteText source={editing.text} />
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
                onChange={(e) => write(e.target.value, editing.etag)}
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
          <div className="row">
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save note'}
            </Button>
            <Button kind="quiet" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
