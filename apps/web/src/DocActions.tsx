import { can, type DocumentView, type Role } from '@fdv/shared';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp } from './app-context.js';
import { SharePanel } from './screens/Share.js';
import { VisibilityControl } from './screens/Visibility.js';
import { storedRole } from './session.js';
import { ErrorNote, MoveToTrashDialog, TrashIcon, useSheetFocus } from './ui.js';
import { createUploadKeys, whileInProgress } from './upload-keys.js';

/**
 * Quick actions on every document (5.4): a ⋯ beside each row in a list
 * offers what the document's own page offers, without going there first.
 * On a narrow screen it opens a sheet from the bottom; on a wide one, a menu
 * beside the ⋯.
 */

export type DocAction =
  | 'open'
  | 'download'
  | 'read'
  | 'edit'
  | 'share'
  | 'visibility'
  | 'essential'
  | 'version'
  | 'trash';

/**
 * Who may change a document: whoever may change documents, and a teen only
 * their own, as the vault itself says (5.1). The document's page asks the
 * same question before it offers Move to Trash.
 */
export function mayChange(
  role: Role,
  memberId: string | null | undefined,
  doc: Pick<DocumentView, 'owner_member_id'>,
): boolean {
  const mine = Boolean(memberId) && doc.owner_member_id === memberId;
  return can(role, 'document.edit') && (role !== 'teen' || mine);
}

/**
 * What the ⋯ offers for one document (A14), in order: only what would not
 * be refused. The vault decides regardless; this only decides what is
 * drawn. With no document yet (a search hit's is still on its way), Open.
 */
export function actionsFor(
  role: Role,
  memberId: string | null | undefined,
  doc: Pick<DocumentView, 'owner_member_id' | 'visibility' | 'latest_version_id'> | null,
): DocAction[] {
  const actions: DocAction[] = ['open'];
  if (!doc) return actions;
  const hasFile = doc.latest_version_id !== null;
  if (hasFile) actions.push('download');
  // Somebody who can change nothing (a viewer) is given what they came
  // for: Open and Download.
  if (!can(role, 'document.edit')) return actions;
  const changes = mayChange(role, memberId, doc);
  const mine = Boolean(memberId) && doc.owner_member_id === memberId;
  if (hasFile) actions.push('read');
  if (changes) actions.push('edit');
  // A link sends the file: with none yet, the vault has nothing to send.
  if (hasFile && can(role, 'document.share')) actions.push('share');
  // Making something Only me, or taking it back, is its owner's alone.
  if (can(role, 'document.visibility') && (doc.visibility !== 'private' || mine)) {
    actions.push('visibility');
  }
  if (changes) actions.push('essential');
  if (changes && can(role, 'document.add')) actions.push('version');
  if (changes) actions.push('trash');
  return actions;
}

function labelFor(action: DocAction, doc: DocumentView | null): string {
  switch (action) {
    case 'open':
      return 'Open';
    case 'download':
      return 'Download';
    case 'read':
      return 'Read full size';
    case 'edit':
      return 'Edit details';
    case 'share':
      return 'Share a link';
    case 'visibility':
      return 'Who can see';
    case 'essential':
      return doc?.is_essential ? 'Stop it being Essential' : 'Make it Essential';
    case 'version':
      return 'Add a new version';
    case 'trash':
      return 'Move to Trash';
  }
}

/** The most the menu can be: an owner's nine items, 44 px each, and its edges. */
const MENU_TALLEST = 9 * 44 + 18;
/** However little room there is, three items and a bit, so it is seen to scroll. */
const MENU_SHORTEST = 132;

/**
 * Where the menu sits on a wide screen: under the ⋯ with its right edge
 * lined up, or above it when there is not room for it below and there is
 * more above. It is never taller than the room on its side, so all of it
 * is on the screen, scrolling inside itself when it has to. A narrow
 * screen ignores this and shows a sheet from the bottom (styles.css).
 */
export function beside(button: HTMLElement | null): CSSProperties {
  if (!button) return {};
  const r = button.getBoundingClientRect();
  const high = window.innerHeight;
  const below = high - r.bottom - 8;
  const above = r.top - 8;
  const up = below < Math.min(MENU_TALLEST, high * 0.6) && above > below;
  const at: Record<string, string> = {
    '--menu-right': `${Math.max(8, window.innerWidth - r.right)}px`,
    '--menu-max': `${Math.max(MENU_SHORTEST, (up ? above : below) - 4)}px`,
  };
  if (up) at['--menu-bottom'] = `${high - r.top + 4}px`;
  else at['--menu-top'] = `${r.bottom + 4}px`;
  return at;
}

export function DocActions(props: {
  documentId: string;
  /** The title as the row shows it. */
  title: string;
  /** The row's own copy. A search hit has none, so its menu fetches it on opening. */
  doc?: DocumentView;
  /** Something about it changed: the list is loaded again. */
  onChanged: () => void | Promise<unknown>;
}) {
  const { withToken, guarded, session } = useApp();
  const navigate = useNavigate();
  const more = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [menu, setMenu] = useState<{ start: 'first' | 'last'; at: CSSProperties } | null>(null);
  const [fetched, setFetched] = useState<{ doc: DocumentView | null; error: string | null }>({
    doc: null,
    error: null,
  });
  const [sheet, setSheet] = useState<'share' | 'visibility' | 'trash' | null>(null);
  // What the sheet holds is on its way: Escape leaves it open until it is done.
  const [sheetBusy, setSheetBusy] = useState(false);
  // Who can see it was changed in the sheet: the list is loaded again when
  // the sheet closes, not under it.
  const changedInSheet = useRef(false);
  const [trashing, setTrashing] = useState(false);
  // Essential being turned on or off: not chosen again until the vault answers.
  const [toggling, setToggling] = useState(false);
  // The copy Essential was last saved to, and the ETags it has replaced.
  // Until the list is loaded again the row still has one of those, and
  // this is what is there now (5.4).
  const [saved, setSaved] = useState<{ doc: DocumentView; replaces: string[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys] = useState(createUploadKeys);

  const drawn = props.doc ?? fetched.doc;
  const doc = saved && drawn && saved.replaces.includes(drawn.etag) ? saved.doc : drawn;
  const memberId = session.info?.member_id;
  const offered = actionsFor(storedRole(), memberId, doc);

  // A row that leaves its list takes its ⋯ with it. If focus was there, it
  // goes to what the list says about itself, which stays, not to nowhere.
  useLayoutEffect(() => {
    const row = more.current?.closest('li');
    return () => {
      if (row?.contains(document.activeElement)) landing(row)?.focus();
    };
  }, []);

  const openMenu = (start: 'first' | 'last') => {
    setNote(null);
    setError(null);
    setMenu({ start, at: beside(more.current) });
    if (props.doc) return;
    // A search hit has no version or ETag: what may be done with it is
    // decided on the document itself, as it is now.
    setFetched({ doc: null, error: null });
    void withToken((t) => api.document(t, props.documentId)).then(
      (d) => setFetched({ doc: d, error: null }),
      (err: unknown) => setFetched({ doc: null, error: describeError(err) }),
    );
  };

  const download = async () => {
    try {
      const versions = await withToken((t) => api.versions(t, props.documentId));
      const current = versions?.items[0];
      if (!current) return;
      // An Essential or an "only me" document may ask who is asking first.
      const blob = await guarded((t) => api.content(t, current.id));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = current.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const toggleEssential = async (d: DocumentView) => {
    const next = !d.is_essential;
    setToggling(true);
    try {
      // With the ETag of the copy it was drawn from: a change made since is
      // not quietly overwritten. Turning it off takes away the question
      // opening it asks, so the vault may ask that first (SEC-17).
      const result = await guarded((t) =>
        api.updateDocument(t, d.id, { is_essential: next }, d.etag),
      );
      setToggling(false);
      if (!result) return;
      setSaved((s) => ({ doc: result, replaces: [...(s?.replaces ?? []), d.etag] }));
      setNote(
        next ? `“${props.title}” is Essential now.` : `“${props.title}” is not Essential any more.`,
      );
      await props.onChanged();
    } catch (err) {
      setToggling(false);
      if (err instanceof ApiRequestError && err.status === 409) {
        // Changed somewhere else since the list was loaded. It is loaded
        // again, so the next try is made on what is there now.
        setSaved(null);
        setNote(
          `“${props.title}” was changed somewhere else, so it has been loaded again. Try again if it still needs changing.`,
        );
        await props.onChanged();
        return;
      }
      setError(describeError(err));
    }
  };

  const addVersion = async (chosen: File | undefined) => {
    if (!chosen) return;
    setError(null);
    setNote(`Adding a new version of “${props.title}”…`);
    try {
      const key = keys.keyFor(chosen);
      const made = await whileInProgress(() =>
        withToken((t) => api.upload(t, props.documentId, chosen, key)),
      );
      keys.saved();
      setNote(made ? `A new version of “${props.title}” was added.` : null);
      await props.onChanged();
    } catch (err) {
      setNote(null);
      setError(describeError(err));
    }
  };

  const remove = async () => {
    setTrashing(true);
    try {
      await withToken((t) => api.deleteDocument(t, props.documentId));
      // The row goes when the list is loaded again, and its ⋯ with it, so
      // focus goes to the next row (or the one before) rather than nowhere.
      // The only row in its list leaves it to the list's heading (landing).
      const row = more.current?.closest('li');
      const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector(
        'button',
      );
      flushSync(() => {
        setTrashing(false);
        setSheet(null);
      });
      neighbour?.focus();
      await props.onChanged();
    } catch (err) {
      setTrashing(false);
      setSheet(null);
      setError(describeError(err));
    }
  };

  const choose = (action: DocAction) => {
    setMenu(null);
    const at = `/documents/${props.documentId}`;
    switch (action) {
      case 'open':
        void navigate(at);
        return;
      case 'read':
        void navigate(`${at}/read`);
        return;
      case 'edit':
        void navigate(`${at}/confirm`);
        return;
      case 'download':
        void download();
        return;
      case 'essential':
        if (doc && !toggling) void toggleEssential(doc);
        return;
      case 'version':
        // Still inside the tap, so the browser lets the file chooser open.
        file.current?.click();
        return;
      case 'share':
      case 'visibility':
      case 'trash':
        setSheet(action);
        return;
    }
  };

  const closeSheet = () => {
    setSheet(null);
    setSheetBusy(false);
    // After "I understand", Cancel, or a save with nothing to say. A search
    // hit made Only me can leave the results when they are loaded again,
    // and would take "Only you can open this" with it, unread; the vault
    // says that once (SEC-19).
    if (!changedInSheet.current) return;
    changedInSheet.current = false;
    void props.onChanged();
  };

  return (
    <>
      <button
        ref={more}
        type="button"
        className="more"
        aria-label={`Actions for “${props.title}”`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-controls={menu ? menuId : undefined}
        onClick={() => (menu ? setMenu(null) : openMenu('first'))}
        onKeyDown={(e) => {
          // As a menu button does: down opens at the top, up at the bottom.
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <p className="notice status-line" role="status">
        {note}
      </p>
      <ErrorNote message={error} />
      <input
        ref={file}
        type="file"
        accept="image/*,application/pdf"
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          // Cleared, so the same file chosen again is a retry, not nothing.
          e.target.value = '';
          void addVersion(chosen);
        }}
      />
      {menu && (
        <ActionMenu
          id={menuId}
          label={`Actions for “${props.title}”`}
          title={props.title}
          items={offered.map((action) => ({
            action,
            label: labelFor(action, doc),
            waiting: action === 'essential' && toggling,
          }))}
          start={menu.start}
          at={menu.at}
          waiting={!doc && !fetched.error}
          error={props.doc ? null : fetched.error}
          returnFocus={more}
          onChoose={choose}
          onClose={() => setMenu(null)}
        />
      )}
      {sheet === 'share' && (
        <Sheet
          label={`Share “${props.title}”`}
          busy={sheetBusy}
          returnFocus={more}
          onClose={closeSheet}
        >
          <SharePanel
            documentId={props.documentId}
            documentTitle={doc?.title ?? null}
            onClose={closeSheet}
            onBusy={setSheetBusy}
          />
        </Sheet>
      )}
      {sheet === 'visibility' && doc && (
        <Sheet
          label={`Who can see “${props.title}”`}
          busy={sheetBusy}
          returnFocus={more}
          onClose={closeSheet}
        >
          <VisibilityControl
            documentId={props.documentId}
            current={doc.visibility}
            isMine={doc.owner_member_id !== null && doc.owner_member_id === memberId}
            onChanged={async () => {
              changedInSheet.current = true;
            }}
            onClose={closeSheet}
            onBusy={setSheetBusy}
          />
        </Sheet>
      )}
      {sheet === 'trash' && (
        <MoveToTrashDialog
          title={doc?.title ?? null}
          busy={trashing}
          returnFocus={more}
          onConfirm={() => void remove()}
          onCancel={closeSheet}
        />
      )}
    </>
  );
}

/**
 * The menu itself. Focus starts on its first item (or its last, opened
 * with the up arrow), the arrows move between items, Tab stays inside,
 * and Escape or a tap outside closes it, giving focus back to the ⋯.
 */
function ActionMenu(props: {
  id: string;
  label: string;
  title: string;
  /** `waiting`: already on its way, so not chosen again until it is done. */
  items: Array<{ action: DocAction; label: string; waiting: boolean }>;
  start: 'first' | 'last';
  at: CSSProperties;
  /** A search hit's document is still on its way. */
  waiting: boolean;
  error: string | null;
  returnFocus: RefObject<HTMLElement | null>;
  onChoose: (action: DocAction) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  useSheetFocus(box, { start, onEscape: props.onClose, returnFocus: props.returnFocus });
  const startAt = props.start === 'last' ? props.items.length - 1 : 0;

  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.findIndex((item) => item === document.activeElement);
    const last = items.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: at < last ? at + 1 : 0,
      ArrowUp: at > 0 ? at - 1 : last,
      Home: 0,
      End: last,
    };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    items[to]?.focus();
  };

  return (
    <div
      className="menu-layer"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={box} className="menu-box" style={props.at}>
        <p className="menu-title">{props.title}</p>
        <div id={props.id} role="menu" aria-label={props.label} onKeyDown={move}>
          {props.items.map((item, i) => (
            <button
              key={item.action}
              ref={i === startAt ? start : undefined}
              type="button"
              role="menuitem"
              className={`menu-item${item.action === 'trash' ? ' menu-item-danger' : ''}`}
              aria-disabled={item.waiting || undefined}
              onClick={() => {
                if (!item.waiting) props.onChoose(item.action);
              }}
            >
              {item.action === 'trash' && <TrashIcon />}
              {item.label}
            </button>
          ))}
        </div>
        {props.waiting && (
          <p className="muted menu-wait" role="status">
            Seeing what you can do with it…
          </p>
        )}
        <ErrorNote message={props.error} />
      </div>
    </div>
  );
}

/**
 * Sharing, or who can see it, over the list: the same panels as the
 * document's page. While what it holds is on its way, Escape leaves it
 * open, as the "are you sure?" does: what comes back is shown only here.
 */
function Sheet(props: {
  label: string;
  busy: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  useSheetFocus(box, {
    onEscape: props.onClose,
    busy: props.busy,
    returnFocus: props.returnFocus,
  });
  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        aria-busy={props.busy}
      >
        {props.children}
      </section>
    </div>
  );
}

/**
 * Where focus goes when a row leaves its list with focus in it: the line
 * that says what the list holds, when it has one, or its heading. Both stay
 * when the row goes, and say where the person is.
 */
function landing(row: Element): HTMLElement | null {
  const place = row.closest('section, main');
  const at =
    place?.querySelector<HTMLElement>('[data-landing]') ??
    place?.querySelector<HTMLElement>('h2, h1') ??
    null;
  if (at && !at.hasAttribute('tabindex')) at.tabIndex = -1;
  return at;
}
