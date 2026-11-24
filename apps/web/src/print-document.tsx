import {
  CAREGIVER_MARK,
  formatDate,
  isRecordFormat,
  issuedByLabel,
  PREVIEW_MAX_PAGES,
  SENSITIVE_LABEL,
  seesLocation,
  type CoreField,
  type DocumentTypeView,
  type DocumentView,
  type Role,
  type VersionView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp } from './app-context.js';
import { asksFor, coreRule, detailText } from './details.js';
import { NoteText } from './notes.js';
import { placeLine } from './original-place.js';
import { PrintOut, SENSITIVE_PRINT_NOTICE } from './print.js';
import { Button, categoryLabel, Check, Dialog, ErrorNote } from './ui.js';

/**
 * Printing a document (0.9.0): its pages, and a sheet of its details, each
 * ticked or not in a small dialog first.
 *
 * Its pages are the pages the vault drew of it — the same pictures its page
 * shows, fetched by the same request one at a time — so a print shows
 * nothing its page would not, and asks what its page asks: an Essential, an
 * Only me or a Sensitive document's pages ask to confirm it's you first, as
 * Confirm it's you does beside them, and each page printed is in the
 * activity log as each page looked at is. Printing the original file in the
 * browser's own PDF viewer was the other way: it cannot be printed with the
 * details sheet, a frame's Print of a PDF is unreliable from browser to
 * browser, and the vault draws at most the first 30 pages either way the
 * page shows them. So a file the vault does not draw — a Word file, a
 * health record kept as it is — is downloaded to be printed, as it is to be
 * read, and so are a long file's pages past the 30th.
 *
 * The details sheet is what the page's details say, in its words and the
 * family's date format: the kind, whose it is, its dates, its status, its
 * visibility, where the original is kept (for whoever the page tells), the
 * kind's own details, and its note.
 *
 * A Sensitive document (the owner's choice of 24 Nov 2026) prints as any
 * other, its heading saying Sensitive, and the dialog that asks what to
 * print says first to keep the printout safe and shred it: its Cancel
 * prints nothing.
 */

/** One line of the details sheet: what it is, and what it says. */
export interface Fact {
  label: string;
  value: string;
  /** Long text, its lines kept. */
  long?: boolean;
}

/** Its visibility, as its page says it. */
const WHO_SEES: Record<DocumentView['visibility'], string> = {
  household: 'Everyone in the family',
  adults: 'Adults only',
  private: 'Only me',
};

/**
 * The details sheet's lines, as the document's page says them: never where
 * the original is kept for whom the page does not say it (5.41).
 */
export function documentFacts(
  doc: DocumentView,
  type: DocumentTypeView | undefined,
  person: string,
  role: Role | null,
): Fact[] {
  const word = (key: CoreField, fallback: string) => coreRule(type, key).label ?? fallback;
  const facts: Fact[] = [
    { label: 'Type', value: type?.label ?? 'Not set' },
    { label: 'Person', value: person },
  ];
  if (doc.issued_by) facts.push({ label: issuedByLabel(type), value: doc.issued_by });
  if (doc.identifier) facts.push({ label: word('identifier', 'Number'), value: doc.identifier });
  if (doc.issued) facts.push({ label: word('issued', 'Issued'), value: formatDate(doc.issued) });
  if (doc.expires) {
    facts.push({ label: word('expires', 'Expires'), value: formatDate(doc.expires) });
  }
  // The kind's own details, in its order (5.10).
  for (const field of (type?.fields ?? []).filter(asksFor)) {
    const value = doc.extra[field.key];
    if (value === undefined || value === null || value === '') continue;
    facts.push({
      label: field.label,
      value: detailText(field.kind, value),
      ...(field.kind === 'long_text' ? { long: true } : {}),
    });
  }
  facts.push({
    label: 'Status',
    value: doc.status.value === 'valid' ? 'Nothing to renew' : doc.status.label,
  });
  facts.push({ label: 'Category', value: categoryLabel(doc.category) });
  facts.push({
    label: 'Visibility',
    value: doc.caregiver === true ? CAREGIVER_MARK : WHO_SEES[doc.visibility],
  });
  if (doc.sensitive_effective === true) facts.push({ label: SENSITIVE_LABEL, value: 'Yes' });
  if (seesLocation(role)) {
    const where = [placeLine(doc), doc.physical_location].filter(Boolean).join(' · ');
    if (where) facts.push({ label: word('physical_location', 'Original is kept'), value: where });
  }
  return facts;
}

/**
 * How many of a version's pages can be printed, and what is said of them:
 * none, with why; some, with how many; or not known yet (being drawn), to
 * be found by asking, page by page, as its page does.
 */
export function printablePages(version: VersionView | undefined): {
  pages: number | null;
  words: string;
  none?: boolean;
} {
  if (!version) return { pages: 0, words: 'It has no file yet.', none: true };
  if (version.file_removed) {
    return { pages: 0, words: 'Its file was removed for good.', none: true };
  }
  if (version.stored_as_is === true || isRecordFormat(version.mime)) {
    return {
      pages: 0,
      words: 'A health record kept as it is has no pages to print. Download it to open it.',
      none: true,
    };
  }
  const drawn = version.preview_pages ?? null;
  if (drawn === 0) {
    return {
      pages: 0,
      words: 'The vault can’t draw this file’s pages. Download it to print it.',
      none: true,
    };
  }
  const length = version.page_count ?? null;
  const pages = drawn ?? (length !== null ? Math.min(length, PREVIEW_MAX_PAGES) : null);
  if (pages === null) return { pages: null, words: 'Its pages, as they are drawn.' };
  if (length !== null && length > pages) {
    return {
      pages,
      words: `The first ${pages} of its ${length} pages. Download the file to print the rest.`,
    };
  }
  return { pages, words: pages === 1 ? '1 page.' : `${pages} pages.` };
}

/** What is being printed: the pages' pictures, and whether the sheet goes first. */
interface Job {
  pages: string[];
  sheet: boolean;
}

/**
 * Print, from a document's action row: what to print, then the printing.
 * `facts` and `note` are the details sheet; `version` the file whose pages
 * are printed.
 */
export function PrintDocument(props: {
  title: string;
  version: VersionView | undefined;
  facts: Fact[];
  /** Its note, and what the kind calls it, when it has one. */
  note: { label: string; text: string } | null;
  sensitive: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { guarded } = useApp();
  const printable = printablePages(props.version);
  const [withPages, setWithPages] = useState(printable.none !== true);
  const [withSheet, setWithSheet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  // The pictures made, let go of once printed or closed.
  const made = useRef<string[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const u of made.current) URL.revokeObjectURL(u);
      made.current = [];
    };
  }, []);

  /** Its pages, one after another, as its page fetches them: null when "Confirm it's you" was not. */
  const fetchPages = async (versionId: string): Promise<string[] | null> => {
    const most = printable.pages ?? PREVIEW_MAX_PAGES;
    const urls: string[] = [];
    for (let n = 1; n <= most; n++) {
      // Cancelled (Cancel, Escape): no more pages are asked for.
      if (!alive.current) return null;
      let blob: Blob | null;
      try {
        blob = await guarded((t) => api.page(t, versionId, n), {
          cancelled: () => !alive.current,
        });
      } catch (err) {
        // Not known how many were drawn: the last one drawn has been reached.
        const ended =
          err instanceof ApiRequestError &&
          (err.code === 'no_preview' || err.code === 'preview_pending');
        if (ended && urls.length > 0 && printable.pages === null) break;
        throw err;
      }
      if (!blob || !alive.current) return null;
      const url = URL.createObjectURL(blob);
      made.current.push(url);
      urls.push(url);
    }
    return urls;
  };

  const print = async () => {
    setBusy(true);
    setProblem(null);
    try {
      let pages: string[] = [];
      if (withPages && props.version) {
        const got = await fetchPages(props.version.id);
        if (!got) return;
        pages = got;
      }
      if (alive.current) setJob({ pages, sheet: withSheet });
    } catch (err) {
      if (!alive.current) return;
      setProblem(
        err instanceof ApiRequestError && err.code === 'preview_pending'
          ? 'Its pages are still being drawn. Try again in a moment.'
          : describeError(err),
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (job) {
    return (
      <PrintOut
        title={props.title}
        about={
          job.sheet ? (
            <p className="print-about">
              {props.sensitive ? `Document · ${SENSITIVE_LABEL}` : 'Document'}
            </p>
          ) : props.sensitive ? (
            // Its pages alone: the heading still says it is Sensitive.
            <p className="print-about">{SENSITIVE_LABEL}</p>
          ) : undefined
        }
        onDone={props.onClose}
      >
        {job.sheet && (
          <section className="print-sheet">
            <dl className="print-facts">
              {props.facts.map((f, i) => (
                <div key={`${i}-${f.label}`} className="print-fact">
                  <dt>{f.label}</dt>
                  <dd className={f.long ? 'keep-lines' : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
            {props.note && (
              <div className="print-note">
                <h2>{props.note.label}</h2>
                <NoteText source={props.note.text} />
              </div>
            )}
          </section>
        )}
        {job.pages.map((url, i) => (
          <figure
            key={url}
            className={job.sheet || i > 0 ? 'print-page print-page-new' : 'print-page'}
          >
            <img src={url} alt={`Page ${i + 1} of ${props.title}`} />
          </figure>
        ))}
      </PrintOut>
    );
  }

  return (
    <Dialog
      title={`Print “${props.title}”`}
      // Never held shut while its pages come: Cancel and Escape stop them.
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      closeLabel="Cancel"
      actions={
        <Button
          kind="primary"
          disabled={busy || (!withPages && !withSheet)}
          onClick={() => void print()}
        >
          {busy ? 'Preparing…' : 'Print'}
        </Button>
      }
    >
      {props.sensitive && (
        <p className="print-sensitive" role="note">
          {SENSITIVE_PRINT_NOTICE}
        </p>
      )}
      <fieldset className="print-choices">
        <legend>What to print</legend>
        <Check
          id="print-pages"
          checked={withPages && printable.none !== true}
          disabled={printable.none === true}
          label="Its pages"
          note={printable.words}
          onChange={setWithPages}
        />
        <Check
          id="print-sheet"
          checked={withSheet}
          label="A sheet of its details"
          note="What this page says of it: its kind, whose it is, its dates, its status and its other details."
          onChange={setWithSheet}
        />
      </fieldset>
      <ErrorNote message={problem} />
    </Dialog>
  );
}
