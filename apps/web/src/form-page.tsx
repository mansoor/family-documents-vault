import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from './api.js';
import { Button, TopBar } from './ui.js';

/**
 * A long form on a page of its own (0.9.0-dev.69; the owner's feedback of 18
 * Nov 2026): one editing style for share links and requests alike. A
 * request's form is long, and a pop-up can't hold it, so changing a link
 * moved out of its dialog onto a page laid out as a request's is — the page
 * named at the top with Back, a line saying what it is, then cards, each
 * with a heading ("Who it is for", "Keeping it safe", "What they can do"),
 * and one row of buttons at the foot: what the page is for first, Cancel
 * last. Asking for documents, changing a request and changing a link all
 * draw with these, so they look and behave alike.
 */

/** The page: its name and Back at the top, a line saying what it is, then the cards. */
export function FormPage(props: {
  title: string;
  /** Where Back goes. */
  back: string;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="page page-top has-nav">
      <TopBar title={props.title} back={props.back} />
      {props.lede && <p className="lede">{props.lede}</p>}
      {props.children}
    </main>
  );
}

/** One card of a form page: a heading, and its fields under it. `id` names the heading (`${id}-h`). */
export function FormCard(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card stack" aria-labelledby={`${props.id}-h`}>
      <h2 id={`${props.id}-h`} style={{ fontSize: 18 }}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

/**
 * The row of buttons at a form's foot, in the one order every form keeps
 * (18 Nov 2026): what the form is for first — Make the link, Save the
 * changes — then anything else, and Cancel last. Cancel goes to `cancelTo`
 * as a link, or does `onCancel`; it waits while the form is busy.
 */
export function FormActions(props: {
  /** The primary button's words, and its words while it is busy. */
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled?: boolean;
  /** A submit button (a `<form>`'s), or one that does `onPrimary`. */
  onPrimary?: () => void;
  cancelTo?: string;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="row form-actions">
      <Button
        {...(props.onPrimary ? { onClick: props.onPrimary } : { type: 'submit' as const })}
        disabled={props.busy || props.disabled === true}
      >
        {props.busy ? props.busyLabel : props.label}
      </Button>
      {props.children}
      {props.cancelTo !== undefined ? (
        <Link to={props.cancelTo} className="btn btn-quiet">
          Cancel
        </Link>
      ) : (
        <Button kind="quiet" disabled={props.busy} onClick={() => props.onCancel?.()}>
          Cancel
        </Button>
      )}
    </div>
  );
}

/** Said under the buttons once a form is sent with something wrong in it: the same words everywhere. */
export function PutRightFirst(props: { show: boolean }) {
  if (!props.show) return null;
  return (
    <p className="field-error" role="alert">
      Something above needs putting right first.
    </p>
  );
}

/**
 * Why a change could not be saved, when the link or request itself moved on
 * (18 Nov 2026): changed somewhere else since the page opened (`409
 * conflict`), or ended meanwhile (`410 share_ended`, `410 request_ended`).
 * Null for anything else, which is said as it is.
 */
export function changeTrouble(err: unknown): 'conflict' | 'ended' | null {
  if (!(err instanceof ApiRequestError)) return null;
  if (err.status === 409 && err.code === 'conflict') return 'conflict';
  if (err.status === 410) return 'ended';
  return null;
}

/**
 * The same two troubles said the same way for a link and a request: changed
 * somewhere else — Load it again shows it as it is now, and what was typed
 * here goes — or ended, with the way back to Sharing.
 */
export function ChangeTrouble(props: {
  trouble: 'conflict' | 'ended';
  what: 'link' | 'request';
  onReload: () => void;
  busy?: boolean;
}) {
  if (props.trouble === 'conflict') {
    return (
      <div className="status status-warn stack" role="alert" style={{ gap: 8 }}>
        <span>
          This {props.what} was changed somewhere else since you opened it. Load it again to see it
          as it is now, then make your change. What you typed here is not kept.
        </span>
        <Button kind="quiet" disabled={props.busy === true} onClick={props.onReload}>
          Load it again
        </Button>
      </div>
    );
  }
  return (
    <div className="status status-warn stack" role="alert" style={{ gap: 8 }}>
      <span>
        This {props.what} has ended, so it can’t be changed. Make a new one if you need to.
      </span>
      <Link to="/sharing" className="btn btn-quiet">
        Back to Sharing
      </Link>
    </div>
  );
}
