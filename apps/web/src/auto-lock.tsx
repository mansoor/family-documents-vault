import { isAutoLockMinutes, type AutoLockMinutes } from '@fdv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, quiet } from './api.js';
import { useApp } from './app-context.js';
import { running, useUploads } from './batch-store.js';

/**
 * Lock by itself after a while away (0.9.0-dev.87).
 *
 * The vault locks a browser's session nobody has used for the time in
 * effect (GET /me's `auto_lock_minutes`: the family's, or the person's own
 * shorter one); this is the page's half of it:
 *
 *  - **Real use, in every tab.** The mouse, the keys, scrolling, a touch,
 *    the window coming back into focus: each is use, written down for every
 *    tab of this browser (localStorage), at most every few seconds. One tab
 *    in use keeps them all open.
 *  - **The vault told.** While somebody uses the page, it says they are still
 *    here (`POST /auth/still-here`) at most about once a minute across all
 *    its tabs, so reading a long document, which asks the vault nothing, is
 *    use too. What the page asks by itself (`quiet`) is never use.
 *  - **Locked at once.** As the time runs out the page locks itself, without
 *    waiting to ask the vault anything, as Lock locks it; and a minute before,
 *    it says so, quietly, for anybody who is there to move the mouse.
 *  - **An upload is somebody's.** While an upload of many documents sends,
 *    it is never locked, and the vault is told somebody is still here; once
 *    it stops, it locks at once if nobody has used the page meanwhile.
 */

/** How often a tab writes down that it was used, for the other tabs. */
export const ACTIVE_WRITE_EVERY_MS = 5_000;
/** How often, at most, the vault is told somebody is still here, from all of this browser's tabs. */
export const STILL_HERE_EVERY_MS = 60_000;
/** How long before it locks the page says so. */
export const WARN_BEFORE_MS = 60_000;
/** How often an open page asks the vault again for the time in effect. */
export const AUTO_LOCK_ASK_AGAIN_MS = 5 * 60_000;

/** What counts as use: never a timer, nor anything the page does by itself. */
export const USE_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'scroll',
  'touchstart',
  'focus',
] as const;

/** Said a minute before it locks. */
export const LOCK_SOON_WORDS =
  'The vault locks in a minute. Move the mouse, press a key or tap the screen to keep it open.';

const activeKey = (member: string) => `fdv.active.${member}`;
const toldKey = (member: string) => `fdv.stillHere.${member}`;

function readTime(key: string): number {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeTime(key: string, at: number): void {
  try {
    window.localStorage.setItem(key, String(at));
  } catch {
    // Blocked storage: this tab keeps its own time, and the vault is still told.
  }
}

/**
 * The page's timers, for one person signed in with a time in effect:
 * `lockSoon` while the last minute runs, and `onLock` called once, as it
 * runs out. Nothing while `minutes` is null.
 *
 * Coming back to the page (the tab shown again, the computer woken) looks
 * first: past the time, it locks, and no key pressed after that counts.
 * While `holding` (an upload of many documents sending), it never locks,
 * and tells the vault somebody is still here about once a minute; once that
 * stops, it locks at once if nobody has used the page for the time.
 */
export function useAwayTimer(props: {
  member: string | null;
  minutes: AutoLockMinutes | null;
  onLock: () => void;
  onStillHere: () => void;
  holding?: boolean;
}): { lockSoon: boolean } {
  const { member, minutes, onLock, onStillHere } = props;
  const holding = props.holding === true;
  const [lockSoon, setLockSoon] = useState(false);
  const soon = useRef(false);
  // When this browser was last used, as far as this tab knows.
  const last = useRef(0);
  const written = useRef(0);
  const told = useRef(0);
  const timer = useRef<number | null>(null);
  const done = useRef(false);
  const lockRef = useRef(onLock);
  const toldRef = useRef(onStillHere);
  const holdRef = useRef(holding);
  // The timers' own look, for a change from outside them (`holding`).
  const look = useRef<(() => void) | null>(null);
  useEffect(() => {
    lockRef.current = onLock;
    toldRef.current = onStillHere;
  });
  useEffect(() => {
    holdRef.current = holding;
    look.current?.();
  }, [holding]);

  useEffect(() => {
    if (!member || minutes === null) return;
    const limit = minutes * 60_000;
    done.current = false;
    // Opened, or unlocked, just now: that is use.
    last.current = Math.max(Date.now(), readTime(activeKey(member)));
    const lastUse = () => Math.max(last.current, readTime(activeKey(member)));

    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    const say = (now: boolean) => {
      if (soon.current === now) return;
      soon.current = now;
      setLockSoon(now);
    };
    /** The vault told somebody is still here, by one tab of all of this browser's, about once a minute. */
    const tell = (now: number) => {
      if (now - told.current < STILL_HERE_EVERY_MS) return;
      const byAny = readTime(toldKey(member));
      if (now - byAny >= STILL_HERE_EVERY_MS) {
        writeTime(toldKey(member), now);
        told.current = now;
        toldRef.current();
      } else {
        told.current = byAny;
      }
    };
    const check = () => {
      clear();
      if (done.current) return;
      const now = Date.now();
      // An upload sending: never locked meanwhile, and the vault told.
      if (holdRef.current) {
        say(false);
        tell(now);
        timer.current = window.setTimeout(check, STILL_HERE_EVERY_MS);
        return;
      }
      const since = now - lastUse();
      if (since >= limit) {
        done.current = true;
        say(false);
        lockRef.current();
        return;
      }
      const near = since >= limit - WARN_BEFORE_MS;
      say(near);
      const next = near ? limit - since : limit - WARN_BEFORE_MS - since;
      timer.current = window.setTimeout(check, Math.max(250, next));
    };
    look.current = check;

    const used = () => {
      if (done.current) return;
      const now = Date.now();
      // Woken, or a timer held back, past the time: locked, and this does not count.
      if (!holdRef.current && now - lastUse() >= limit) {
        check();
        return;
      }
      last.current = now;
      if (now - written.current >= ACTIVE_WRITE_EVERY_MS) {
        written.current = now;
        writeTime(activeKey(member), now);
      }
      tell(now);
      // The warning goes as somebody comes back, and the next check is set again.
      if (soon.current) check();
    };
    // Another tab of this browser was used.
    const heard = (e: StorageEvent) => {
      if (e.key !== activeKey(member)) return;
      const at = Number(e.newValue);
      if (Number.isFinite(at) && at > last.current) {
        last.current = at;
        check();
      }
    };
    // The page shown again, or come back to from the browser's cache: looked
    // at before anything counts as use.
    const back = () => {
      if (document.visibilityState !== 'hidden') check();
    };

    document.addEventListener('visibilitychange', back, { capture: true });
    window.addEventListener('pageshow', back, { capture: true });
    for (const name of USE_EVENTS) {
      window.addEventListener(name, used, { capture: true, passive: true });
    }
    window.addEventListener('storage', heard);
    // The first look, and the timer from it: the warning is said only later.
    check();
    return () => {
      clear();
      look.current = null;
      document.removeEventListener('visibilitychange', back, { capture: true });
      window.removeEventListener('pageshow', back, { capture: true });
      for (const name of USE_EVENTS) {
        window.removeEventListener(name, used, { capture: true });
      }
      window.removeEventListener('storage', heard);
    };
  }, [member, minutes]);

  return { lockSoon: member !== null && minutes !== null && lockSoon };
}

/** Fired on `window` as a time is changed in Settings: the page asks the vault again. */
export const AUTO_LOCK_CHANGED = 'fdv:auto-lock-changed';

/** Written as a time is changed in Settings: every other tab of this browser asks the vault again. */
export const AUTO_LOCK_CHANGED_KEY = 'fdv.autoLockChanged';

/** A time changed in Settings: said to this tab, and to every other of this browser. */
export function autoLockChanged(): void {
  try {
    window.localStorage.setItem(AUTO_LOCK_CHANGED_KEY, String(Date.now()));
  } catch {
    // Blocked storage: the other tabs ask again as they are come back to.
  }
  window.dispatchEvent(new Event(AUTO_LOCK_CHANGED));
}

/**
 * For a signed-in page (the shell): the time in effect, asked of the vault
 * by itself as the page opens, as it is come back to, every few minutes,
 * and as a time is changed in Settings in any tab; the page's timers, held
 * off while an upload of many documents sends; the lock as it runs out; and
 * the minute's warning, said politely.
 */
export function AutoLock() {
  const { session, withToken, lock, authVersion, caps } = useApp();
  const member = session.info?.member_id ?? null;
  const offered = caps?.features.auto_lock === true;
  const [minutes, setMinutes] = useState<AutoLockMinutes | null>(null);
  const [asked, setAsked] = useState(0);
  const [upload] = useUploads();
  const sending = running(upload);

  useEffect(() => {
    const again = () => setAsked((n) => n + 1);
    const changedElsewhere = (e: StorageEvent) => {
      if (e.key === AUTO_LOCK_CHANGED_KEY) again();
    };
    const back = () => {
      if (document.visibilityState !== 'hidden') again();
    };
    window.addEventListener(AUTO_LOCK_CHANGED, again);
    window.addEventListener('storage', changedElsewhere);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    const timer = window.setInterval(again, AUTO_LOCK_ASK_AGAIN_MS);
    return () => {
      window.removeEventListener(AUTO_LOCK_CHANGED, again);
      window.removeEventListener('storage', changedElsewhere);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!offered) return;
    let live = true;
    withToken((t) => quiet.me(t))
      .then((me) => {
        if (!live || !me) return;
        const m = me.auto_lock_minutes;
        setMinutes(isAutoLockMinutes(m) ? m : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [withToken, offered, authVersion, asked]);

  const onStillHere = useCallback(() => {
    void withToken((t) => api.stillHere(t)).catch(() => undefined);
  }, [withToken]);
  const onLock = useCallback(() => void lock({ away: true }), [lock]);
  const { lockSoon } = useAwayTimer({
    member,
    minutes: offered ? minutes : null,
    onLock,
    onStillHere,
    holding: sending,
  });

  // Drawn only while a time is in effect, so its region is there, empty,
  // long before it speaks.
  if (!offered || minutes === null) return null;
  return (
    <div className="auto-lock-soon" role="status" aria-live="polite">
      {lockSoon ? <p>{LOCK_SOON_WORDS}</p> : null}
    </div>
  );
}
