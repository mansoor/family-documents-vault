import {
  canRemovePhoto,
  initialsFor,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  roleLabel,
  shortName,
  type PhotoCrop,
  type Role,
} from '@fdv/shared';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { PersonAvatar } from '../person-avatar.js';
import { storedRole } from '../session.js';
import { BottomNav, ConfirmDialog, ErrorNote, Sheet, TopBar } from '../ui.js';
import { DocRow } from './Home.js';
import { RoleControls } from './Roles.js';

/**
 * A person (5.17c). A name on People opens their profile, which also lists
 * their documents; a name on Home opens their documents (A64).
 */

/** Where the screen came from, if the link that opened it said. */
interface Came {
  from?: string;
}

/**
 * What a screen calls somebody: their first name, or their whole name when
 * somebody else in the family has the same first name (`shortName`: Sam
 * Khan and Sam Malik are not both "Sam").
 */
const nameOf = (m: Member, family: ReadonlyArray<Member>) =>
  shortName(family.length > 0 ? family : [m]).get(m.id) ??
  (m.display_name.trim().split(/\s+/)[0] || m.display_name);

/** "12 March 2012 · 14"; no age once they have died. */
export function bornLine(dateOfBirth: string, deceased: boolean, today = new Date()): string {
  const [y, mo, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const born = new Date(y, mo - 1, d);
  const words = born.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  if (deceased) return words;
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age -= 1;
  return age >= 0 ? `${words} · ${age}` : words;
}

/** The one line under a person's name. */
export function roleLine(m: Member): string {
  if (m.is_deceased) return 'Passed away';
  if (m.is_me && m.role) return `You · ${roleLabel(m.role)}`;
  if (m.role) return roleLabel(m.role);
  if (m.sign_in_removed) return 'Their sign-in was taken away';
  return 'No sign-in';
}

/**
 * The owners' note about ID numbers, until identity records land (A69,
 * 5.26/5.27). Every sentence is what the vault does (the 5.17c review):
 * AddConfirm's startingVisibility, effectiveVisibility and the API's
 * ownVisibility, and visibilityRefusal (A72) for who changes it.
 */
export const ID_NUMBERS_NOTE =
  "SSN and other ID numbers get their own sealed place here in a later release. Until then they are kept in 'Social security / national ID' documents. One an owner or adult files is Adults only by default: owners and adults can open it, teens and viewers can't. One a teen files is their Only me by default: only they can open it, or make it Everyone. Owners and adults can change who sees the documents they can open, and make their own Only me; teens can switch their own documents that they filed between Only me and Everyone. In Kinds of document an owner can make Only me the default for the ones people file for themselves.";

/** How long a new photo is waited for, and how often it is asked about. */
export const PHOTO_POLL_MS = 2000;
export const PHOTO_WAIT_MS = 60_000;

const PHOTO_SEEN = 'Everyone in the family can see this photo. Viewers see only their own.';

/** How many of their documents the profile shows before "See all". */
const FIRST_DOCUMENTS = 5;

export function ProfileScreen() {
  const { id } = useParams<{ id: string }>();
  const { authVersion, session } = useApp();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [members, docs, types] = await Promise.all([
        api.members(t),
        api.documents(t, { member_id: id, limit: FIRST_DOCUMENTS }),
        api.documentTypes(t),
      ]);
      return {
        members: members.items,
        member: members.items.find((m) => m.id === id) ?? null,
        docs: docs.items,
        types: types.items,
      };
    },
    [id, authVersion],
  );
  const member = data?.member ?? null;
  const name = member ? nameOf(member, data?.members ?? []) : '';
  const myRole: Role = session.info?.role ?? storedRole();

  if (data && !member) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="Person" back="/people" />
        <p className="lede">We can’t find that person.</p>
        <Link to="/people" className="btn btn-quiet">
          Back to People
        </Link>
        <BottomNav />
      </main>
    );
  }

  const about = member
    ? [
        member.relationship ? { label: 'Relationship', value: member.relationship } : null,
        member.date_of_birth
          ? { label: 'Born', value: bornLine(member.date_of_birth, member.is_deceased) }
          : null,
      ].filter((r): r is { label: string; value: string } => r !== null)
    : [];

  return (
    <main className="page page-top has-nav">
      <TopBar title={member?.display_name ?? 'Person'} back="/people" />
      <ErrorNote message={error} />
      {member && (
        <>
          <div className="profile-head">
            <PersonAvatar
              person={member}
              initials={initialsFor(data?.members ?? []).get(member.id)}
              size={96}
            />
            <p className="profile-line">{roleLine(member)}</p>
            <PhotoControls member={member} name={name} onChanged={reload} />
          </div>

          {about.length > 0 && (
            <section className="card stack" aria-labelledby="about-h">
              <h2 id="about-h" style={{ fontSize: 18 }}>
                About
              </h2>
              <dl className="facts">
                {about.map((r) => (
                  <Fragment key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          )}

          {myRole === 'owner' && (
            <section className="card stack" aria-labelledby="ids-h">
              <h2 id="ids-h" style={{ fontSize: 18 }}>
                ID numbers
              </h2>
              <p className="muted">{ID_NUMBERS_NOTE}</p>
            </section>
          )}

          <section aria-labelledby="their-docs-h">
            <h2 id="their-docs-h" className="section-h">
              {member.is_me ? 'Your documents' : `${name}’s documents`}
            </h2>
            <ul className="list">
              {(data?.docs ?? []).map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  types={data?.types}
                  onOpen={() => void navigate(`/documents/${d.id}`)}
                  onChanged={reload}
                />
              ))}
              {data && data.docs.length === 0 && <li className="muted">No documents yet.</li>}
            </ul>
            {member.document_count > 0 && (
              <Link
                to={`/people/${member.id}/documents`}
                state={{ from: `/people/${member.id}` } satisfies Came}
                className="muted seeall"
              >
                See all {member.document_count} document{member.document_count === 1 ? '' : 's'}
              </Link>
            )}
          </section>

          <RoleControls member={member} onChanged={reload} />
        </>
      )}
      <BottomNav />
    </main>
  );
}

/** A person's documents, all of them: from their name on Home, or from their profile. */
export function PersonDocumentsScreen() {
  const { id } = useParams<{ id: string }>();
  const { authVersion } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  // Back to where this was opened from: Home, or their profile (and their
  // profile for an old bookmark or a link from anywhere else).
  const from = (location.state as Came | null)?.from;
  const back = from === '/' ? '/' : `/people/${id ?? ''}`;
  const { data, error, reload } = useLoad(
    async (t) => {
      const [members, docs, types] = await Promise.all([
        api.members(t),
        api.documents(t, { member_id: id, limit: 100 }),
        api.documentTypes(t),
      ]);
      return {
        members: members.items,
        member: members.items.find((m) => m.id === id) ?? null,
        docs: docs.items,
        types: types.items,
      };
    },
    [id, authVersion],
  );
  const member = data?.member ?? null;
  const name = member ? nameOf(member, data?.members ?? []) : '';
  const title = member ? (member.is_me ? 'Your documents' : `${name}’s documents`) : 'Documents';
  return (
    <main className="page page-top has-nav">
      <TopBar title={title} back={back} />
      <ErrorNote message={error} />
      {data && !member && <p className="lede">We can’t find that person.</p>}
      {member && (
        <Link to={`/people/${member.id}`} className="muted quiet-link">
          About {member.is_me ? 'you' : name}
        </Link>
      )}
      <ul className="list">
        {(data?.docs ?? []).map((d) => (
          <DocRow
            key={d.id}
            doc={d}
            types={data?.types}
            onOpen={() => void navigate(`/documents/${d.id}`)}
            onChanged={reload}
          />
        ))}
        {data && member && data.docs.length === 0 && <li className="muted">No documents yet.</li>}
      </ul>
      <BottomNav />
    </main>
  );
}

/**
 * The photo buttons under a person's name: Add or Change for whoever may
 * (A66), Remove also for the person themselves. A photo chosen is cropped
 * here, and sent only when "Use this photo" is pressed; the vault makes it,
 * and this asks every 2 seconds whether it has.
 */
function PhotoControls(props: {
  member: Member;
  /** What the screen calls them (`nameOf`). */
  name: string;
  onChanged: () => Promise<void>;
}) {
  const { member } = props;
  const { withToken, session } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [waiting, setWaiting] = useState<{ since: number; before: string | null } | null>(null);
  const onChanged = useRef(props.onChanged);
  useEffect(() => {
    onChanged.current = props.onChanged;
  });

  // Asked again every 2 s until the vault has made it, refused it, or a
  // minute has gone by.
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const tick = async () => {
      if (!live) return;
      if (Date.now() - waiting.since >= PHOTO_WAIT_MS) {
        setSaid('Still getting it ready. It will appear when it’s done.');
        setWaiting(null);
        return;
      }
      try {
        const now = (await withToken((t) => api.members(t)))?.items.find((m) => m.id === member.id);
        if (!live) return;
        if (now?.photo_status === 'failed') {
          setSaid('We couldn’t use that photo. Try another one.');
          setWaiting(null);
          return;
        }
        if (now && now.photo_status !== 'processing' && now.photo?.id !== waiting.before) {
          setSaid('Photo updated.');
          setWaiting(null);
          await onChanged.current();
          return;
        }
      } catch {
        // A blip: asked again next time.
      }
      if (live) timer = setTimeout(() => void tick(), PHOTO_POLL_MS);
    };
    let timer = setTimeout(() => void tick(), PHOTO_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waiting, member.id, withToken]);

  const may = member.can_change_photo === true;
  const viewer = {
    role: session.info?.role ?? storedRole(),
    memberId: session.info?.member_id ?? null,
  };
  const mayRemove =
    Boolean(member.photo) &&
    (may || canRemovePhoto(viewer, { id: member.id, role: member.role ?? null }));
  if (!may && !mayRemove && !said) return null;

  const pick = (file: File | undefined) => {
    setError(null);
    setSaid(null);
    if (!file) return;
    if (file.size > PHOTO_MAX_BYTES) {
      setError('That photo is over 20 MB. Choose a smaller one.');
      return;
    }
    setChosen(file);
  };

  const send = async (crop: PhotoCrop | null) => {
    const file = chosen;
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await withToken((t) => api.setMemberPhoto(t, member.id, file, crop));
      flushSync(() => {
        setChosen(null);
        setSaid('Getting the photo ready…');
        setWaiting({ since: Date.now(), before: member.photo?.id ?? null });
      });
      // Back on the button that began it, which stays focusable while the
      // photo is made (the 5.17c review: it was switched off, and focus fell
      // to the page).
      change.current?.focus();
    } catch (err) {
      // Said in the sheet, which stays open for another try: behind it,
      // nobody would see it (the 5.17c review).
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await withToken((t) => api.removeMemberPhoto(t, member.id));
      setRemoving(false);
      setSaid('Photo removed.');
      await props.onChanged();
      // "Remove photo" goes with the photo: focus goes to Add a photo, or,
      // for somebody who may not add one, to what was said (the 5.17c
      // review: it fell to the page).
      (change.current ?? status.current)?.focus();
    } catch (err) {
      // The dialog closes, as the app's others do on a refusal: focus goes
      // back to "Remove photo", and the reason is said on the page, not
      // behind the dialog (the 5.17c review).
      setRemoving(false);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const who = member.is_me ? 'your' : `${props.name}’s`;
  return (
    <div className="stack photo-controls">
      {may && (
        <input
          ref={input}
          type="file"
          accept={PHOTO_TYPES.join(',')}
          aria-label="Choose a photo"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared, so the same photo can be chosen again.
            e.target.value = '';
            pick(file);
          }}
        />
      )}
      {(may || mayRemove) && (
        <div className="row">
          {/* aria-disabled, not disabled, while a photo is sent or made: a
              disabled button drops the focus it holds (as ConfirmDialog's). */}
          {may && (
            <button
              ref={change}
              type="button"
              className="btn btn-quiet"
              aria-disabled={busy || waiting !== null}
              onClick={() => {
                if (!busy && waiting === null) input.current?.click();
              }}
            >
              {member.photo ? 'Change photo' : 'Add a photo'}
            </button>
          )}
          {mayRemove && (
            <button
              type="button"
              className="btn btn-quiet"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) setRemoving(true);
              }}
            >
              Remove photo
            </button>
          )}
        </div>
      )}
      {(may || mayRemove) && <p className="muted">{PHOTO_SEEN}</p>}
      {/* While the sheet is open, what goes wrong is said in it. */}
      {!chosen && <ErrorNote message={error} />}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {chosen && (
        <CropSheet
          file={chosen}
          busy={busy}
          error={error}
          returnFocus={change}
          onUse={(crop) => void send(crop)}
          onCancel={() => {
            setChosen(null);
            setError(null);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={member.is_me ? 'Remove your photo?' : `Remove ${who} photo?`}
          confirmLabel="Remove photo"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={change}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(false)}
        >
          <p>
            {member.is_me ? 'Your' : 'Their'} initials will show instead. The vault’s nightly
            backups keep it until they expire, 30 days by default.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The square the photo is framed in, on screen, in CSS pixels: this, or
 * the room the sheet has if that is less (a 320-pixel screen, or zoomed
 * in), and always square.
 */
const FRAME = 280;
/** How far one arrow key press moves the photo, in CSS pixels. */
const STEP = 12;
const MAX_ZOOM = 4;

/**
 * "Choose the part to show" (5.15's Sheet): the photo in a square frame
 * with a round guide, moved by dragging or with the arrow keys, and zoomed
 * with the slider. Drawn here, from the file: nothing is sent until "Use
 * this photo". A picture this browser cannot draw (HEIC outside Safari) is
 * sent as it is, and the vault uses its middle.
 */
function CropSheet(props: {
  file: File;
  busy: boolean;
  /** Why the last "Use this photo" did not go, said here, where it is seen. */
  error: string | null;
  returnFocus: RefObject<HTMLElement | null>;
  onUse: (crop: PhotoCrop | null) => void;
  onCancel: () => void;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | 'unreadable' | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [frame, setFrame] = useState(FRAME);
  const framed = useRef(FRAME);
  const room = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const use = useRef<HTMLButtonElement>(null);
  const unreadable = size === 'unreadable';
  // The frame is as wide as the sheet has room for, up to FRAME, and as
  // tall: what the round guide shows is what is sent (the 5.17c review: at
  // 320 pixels it was 254 wide and 280 tall). Measured once laid out, and
  // again when the room changes; a page with no layout (a test's) measures
  // nothing, and keeps FRAME.
  useLayoutEffect(() => {
    const el = room.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const next = width > 0 ? Math.min(FRAME, Math.floor(width)) : FRAME;
      if (next === framed.current) return;
      framed.current = next;
      setFrame(next);
      // A new frame, a new middle: where it was is in the old one's pixels.
      setAt(null);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, [unreadable]);
  // A photo this browser cannot draw has no frame to hold the focus: it
  // goes to the one thing left to do.
  useEffect(() => {
    if (size === 'unreadable') use.current?.focus();
  }, [size]);

  useEffect(() => {
    let live = true;
    const make = (globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap> })
      .createImageBitmap;
    const decoded = make ? make(props.file) : Promise.reject(new Error('no createImageBitmap'));
    void decoded.then(
      (bitmap) => {
        if (!live) return;
        setSize({ w: bitmap.width, h: bitmap.height });
        bitmap.close?.();
      },
      () => {
        if (live) setSize('unreadable');
      },
    );
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(props.file) : null;
    // The file's own address, made and let go with the sheet: an outside
    // thing, whose lifetime is this effect's (made in render, a second
    // render would make a second, never let go).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrc(url);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [props.file]);

  const drawn = size && size !== 'unreadable' ? size : null;
  // The photo covers the frame at zoom 1; its side never smaller than a
  // twentieth of the picture, which is what the vault takes.
  const base = drawn ? frame / Math.min(drawn.w, drawn.h) : 1;
  const most = drawn
    ? Math.max(
        1,
        Math.min(MAX_ZOOM, Math.min(drawn.w, drawn.h) / (0.05 * Math.max(drawn.w, drawn.h))),
      )
    : 1;
  const scale = base * zoom;
  const clamp = (p: { x: number; y: number }, s = scale) =>
    drawn
      ? {
          x: Math.min(0, Math.max(frame - drawn.w * s, p.x)),
          y: Math.min(0, Math.max(frame - drawn.h * s, p.y)),
        }
      : p;
  const middle = drawn
    ? { x: (frame - drawn.w * scale) / 2, y: (frame - drawn.h * scale) / 2 }
    : { x: 0, y: 0 };
  const pos = at ?? middle;

  const move = (dx: number, dy: number) => setAt(clamp({ x: pos.x + dx, y: pos.y + dy }));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 4 : STEP;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    move(d[0], d[1]);
  };
  const onZoom = (next: number) => {
    // Zoomed about the middle of the frame.
    const cx = (frame / 2 - pos.x) / scale;
    const cy = (frame / 2 - pos.y) / scale;
    const s = base * next;
    setZoom(next);
    setAt(clamp({ x: frame / 2 - cx * s, y: frame / 2 - cy * s }, s));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, from: pos };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setAt(clamp({ x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }));
  };
  const onUp = () => {
    drag.current = null;
  };

  /**
   * The part shown, as fractions of the upright picture. Its size is
   * rounded first, and where it starts after, never past the edge that
   * leaves: rounded each on its own, a crop at the edge could come to
   * 1.0001 wide, which the vault refused (the 5.17c review).
   */
  const crop = (): PhotoCrop | null => {
    if (!drawn) return null;
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    const w = round(Math.min(1, Math.max(0.05, frame / scale / drawn.w)));
    const h = round(Math.min(1, Math.max(0.05, frame / scale / drawn.h)));
    const x = Math.max(0, Math.min(round(1 - w), round(-pos.x / scale / drawn.w)));
    const y = Math.max(0, Math.min(round(1 - h), round(-pos.y / scale / drawn.h)));
    return { x, y, w, h };
  };

  return (
    <Sheet
      label="Choose the part to show"
      busy={props.busy}
      returnFocus={props.returnFocus}
      onClose={props.onCancel}
    >
      <div className="card stack">
        <h2 style={{ fontSize: 20 }}>Choose the part to show</h2>
        {unreadable ? (
          <p className="muted">
            This browser can’t show this photo, so we’ll use the middle of it.
          </p>
        ) : (
          <>
            <div ref={room} className="crop-room">
              <div
                className="crop-frame"
                role="group"
                tabIndex={0}
                aria-label="The photo in its frame. Drag it, or move it with the arrow keys."
                style={{ width: frame, height: frame }}
                onKeyDown={onKey}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              >
                {src && drawn && (
                  <img
                    className="crop-photo"
                    src={src}
                    alt=""
                    draggable={false}
                    style={{
                      width: drawn.w * scale,
                      height: drawn.h * scale,
                      transform: `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`,
                    }}
                  />
                )}
                <span className="crop-guide" aria-hidden="true" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="crop-zoom">Zoom</label>
              <input
                id="crop-zoom"
                type="range"
                min={1}
                max={most}
                step={0.05}
                value={zoom}
                disabled={!drawn}
                onChange={(e) => onZoom(Number(e.target.value))}
              />
            </div>
          </>
        )}
        <ErrorNote message={props.error} />
        {/* aria-disabled while it is sent, not disabled: a disabled button
            drops the focus it holds, and a refusal would find it gone. */}
        <div className="row">
          <button
            ref={use}
            type="button"
            className="btn btn-primary"
            disabled={size === null}
            aria-disabled={props.busy}
            onClick={() => {
              if (!props.busy) props.onUse(crop());
            }}
          >
            {props.busy ? 'Sending…' : 'Use this photo'}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-disabled={props.busy}
            onClick={() => {
              if (!props.busy) props.onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}
