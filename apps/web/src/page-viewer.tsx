import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useShortcutsOn } from './shortcuts.js';

/**
 * Pages, one at a time (I3; shared since R3): Previous and Next, "Page 2
 * of 3", fitted to the pane's width or at their own size. Page Up and Page
 * Down turn them while the page has the focus — and [ and ], while single
 * keys are on (WCAG 2.1.4). Nothing here fetches: whoever shows it says
 * which page is shown (`n`) and what it is (`url`), and turns it
 * (`onTurn`). A file's in the review queue (BatchItem.tsx's ItemPages) and
 * a document's (Document.tsx's DocumentPages) both use it.
 */
export function PageViewer(props: {
  /** The region's name: "Pages of passport.pdf". */
  label: string;
  className?: string;
  /** How many pages can be turned to; 0 for none, when `none` is said instead. */
  total: number;
  /** How many the file has, when more than can be turned to (said, never turned to). */
  of?: number;
  /** The page shown, from 1. */
  n: number;
  onTurn: (n: number) => void;
  /** The page's picture, once there is one. */
  url: string | null;
  /** Said in its place until then: "Loading the page…". */
  note: ReactNode;
  /** Beside `note`: what can be done about it ("Try again"). */
  noteAction?: ReactNode;
  /** Said when there are no pages to turn. */
  none: ReactNode;
  /** More in the bar, after Fit to width ("Read it full size"). */
  tools?: ReactNode;
  /** Under the hint ("Pages 31–50 aren't shown here"). */
  after?: ReactNode;
}) {
  const { total, n, onTurn } = props;
  const of = props.of ?? total;
  const shortcuts = useShortcutsOn();
  const [fit, setFit] = useState(true);

  // A control inside the page ("Try again", "Confirm it's you") goes away
  // once pressed: the focus it had stays here, on the page, rather than
  // falling to the top of the document (WCAG 2.4.3, the review's W-R3-1).
  const box = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    const now = document.activeElement;
    if (focusInside.current && box.current && (now === null || now === document.body)) {
      box.current.focus({ preventScroll: true });
    }
  });
  const onFocus = () => {
    focusInside.current = true;
  };
  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (to instanceof Node && e.currentTarget.contains(to)) return;
    const from = e.target;
    // Focus gone somewhere: it left. Gone nowhere: it left, unless what had
    // it was taken off the page, when the effect above puts it back here.
    if (to) focusInside.current = false;
    else
      queueMicrotask(() => {
        if (from.isConnected) focusInside.current = false;
      });
  };

  const turn = (by: number) => {
    const to = Math.min(Math.max(n + by, 1), total);
    if (to === n) return false;
    onTurn(to);
    return true;
  };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = e.key === 'PageDown' || (shortcuts && e.key === ']');
    const back = e.key === 'PageUp' || (shortcuts && e.key === '[');
    if (!next && !back) return;
    e.preventDefault();
    turn(next ? 1 : -1);
  };

  return (
    <section className={props.className} aria-label={props.label}>
      {total > 0 ? (
        <>
          <div className="row viewer-bar">
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={n <= 1}
              onClick={() => turn(-1)}
            >
              <span aria-hidden="true">‹ </span>Previous page
            </button>
            <span className="viewer-at" aria-live="polite">
              Page {n} of {of}
            </span>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={n >= total}
              onClick={() => turn(1)}
            >
              Next page<span aria-hidden="true"> ›</span>
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              aria-pressed={fit}
              onClick={() => setFit(!fit)}
            >
              Fit to width
            </button>
            {props.tools}
          </div>
          <div
            className={`viewer${fit ? ' viewer-fit' : ''}`}
            tabIndex={0}
            role="group"
            aria-label={`Page ${n} of ${of}. Page Up and Page Down turn the pages.`}
            aria-keyshortcuts={shortcuts ? 'PageUp PageDown [ ]' : 'PageUp PageDown'}
            onKeyDown={keys}
            ref={box}
            onFocus={onFocus}
            onBlur={onBlur}
          >
            {props.url ? (
              <img src={props.url} alt={`Page ${n} of ${of}`} />
            ) : props.noteAction ? (
              <div className="viewer-note">
                <p className="muted">{props.note}</p>
                {props.noteAction}
              </div>
            ) : (
              <p className="muted">{props.note}</p>
            )}
          </div>
          <p className="muted viewer-hint">
            {shortcuts
              ? 'With the page in focus, Page Up and Page Down, or [ and ], turn the pages.'
              : 'With the page in focus, Page Up and Page Down turn the pages.'}
          </p>
          {props.after}
        </>
      ) : (
        <div className="viewer viewer-none">
          <p className="muted">{props.none}</p>
        </div>
      )}
    </section>
  );
}
