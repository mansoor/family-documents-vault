import { startTransition, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, isSessionOver } from './api.js';
import { useApp } from './app-context.js';
import { lockedFlyouts, readFlyouts } from './flyout-store.js';
import { APP_NAME, pageTitle } from './page-title.js';
import { ConfirmItsYou } from './StepUpPrompt.js';
import { Button, Logo } from './ui.js';

/**
 * The lock screen (0.9.0-dev.86): in place of the whole signed-in app — the
 * list, the documents beside it, the tray, the bars — none of which is
 * drawn while it shows, so nothing of it can be read or reached. One
 * confirmation, as confirming it's you takes (a passkey, the password, a
 * code), unlocks the vault and brings the page back: the document in front
 * opens again, the others are in the tray. Signing out is here too.
 *
 * The focus starts on its heading, which says it is locked; the
 * confirmation is next.
 */
export function LockScreen() {
  const { session, unlocked, lockHeard, markAuthChanged } = useApp();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const [codeToo, setCodeToo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Whether anything was open beside the list, to come back in the tray.
  const [hadOpen] = useState(() => readFlyouts(session.info?.member_id ?? null).items.length > 0);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  // The window's title names no page while it is locked.
  useEffect(() => {
    document.title = `Locked – ${APP_NAME}`;
    return () => {
      document.title = pageTitle(window.location.pathname);
    };
  }, [pathname]);

  // What is kept to put the tray back: the one in front, and the others as
  // icons, none side by side (flyout-store.ts). After the page has gone.
  useEffect(() => {
    lockedFlyouts(session.info?.member_id ?? null);
  }, [session]);

  // Who it is, for the ways to confirm; and the vault told again, should
  // it not have heard the lock (Lock pressed while it could not be reached).
  useEffect(() => {
    let live = true;
    void (async () => {
      const got = await session.token();
      if (got.kind !== 'ok') {
        if (got.kind !== 'offline' && live) markAuthChanged();
        return;
      }
      try {
        const me = await api.me(got.token);
        if (!live) return;
        setCodeToo(me.totp_enabled);
        lockHeard(me.locked === true);
      } catch (err) {
        if (live && isSessionOver(err)) {
          session.clear();
          markAuthChanged();
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [session, markAuthChanged, lockHeard]);

  const back = () => {
    unlocked();
    focusPageOnceDrawn();
  };

  const signOut = async () => {
    setLeaving(true);
    await session.signOut();
    startTransition(() => {
      markAuthChanged();
      void navigate('/sign-in', { replace: true });
    });
  };

  return (
    <main className="page lock-screen" aria-labelledby="lock-h">
      <Logo />
      <div>
        <h1 id="lock-h" ref={heading} tabIndex={-1} className="lock-title">
          The vault is locked
        </h1>
        <p className="lede">
          Nothing in it is shown until you confirm it’s you.
          {hadOpen && ' Your open documents come back in the tray.'}
        </p>
      </div>
      <section className="card stack" aria-labelledby="unlock-h">
        <h2 id="unlock-h" className="lock-confirm-title">
          Confirm it’s you to unlock
        </h2>
        <ConfirmItsYou
          idPrefix="unlock"
          factorOnly={false}
          codeToo={codeToo}
          passwordLabel="Your password"
          confirmWord="Unlock"
          send={(token, body) => api.unlock(token, body)}
          onBusy={setBusy}
          onConfirmed={back}
          onLost={() => markAuthChanged()}
        />
      </section>
      <div className="row">
        <Button kind="quiet" disabled={busy || leaving} onClick={() => void signOut()}>
          {leaving ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </main>
  );
}

/** How long the page is waited for, after unlocking, before its main part takes the focus. */
const PAGE_WAIT_MS = 3000;

/**
 * The page drawn again after unlocking: the focus to its heading once it is
 * there, or to its main part if none comes — never left on the page's body.
 */
function focusPageOnceDrawn(): void {
  const give = (el: HTMLElement) => {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  };
  const heading = () => document.querySelector<HTMLElement>('#main-content h1');
  const now = heading();
  if (now) return give(now);
  const watching = new MutationObserver(() => {
    const h = heading();
    if (!h) return;
    stop();
    give(h);
  });
  const late = window.setTimeout(() => {
    stop();
    const main = document.getElementById('main-content');
    if (main && document.activeElement === document.body) give(main);
  }, PAGE_WAIT_MS);
  function stop() {
    watching.disconnect();
    window.clearTimeout(late);
  }
  watching.observe(document.body, { childList: true, subtree: true });
}
