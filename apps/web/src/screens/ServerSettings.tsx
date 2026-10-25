import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { EmailInPart } from '../mail-in.js';
import { ReadingCheckPart } from '../reading-check.js';
import { ReadingModelPart } from '../reading-settings.js';
import { EmailOutPart } from './Notifications.js';
import { SettingsPage } from './Settings.js';

/**
 * Settings → Server and reading (0.9.0, the owner's ask of 25 Oct 2026):
 * pages that were two each under For owners, now one each in two parts.
 * Each part keeps the address it had, and that address opens the page at
 * its part — scrolled to, its heading given the focus — so a bookmark, a
 * link in the README or one in the vault's own email lands where it did.
 */

/** One part of a page: its heading, and what was a page of its own. */
interface Part {
  /** The address that opens the page at this part. */
  at: string;
  id: string;
  title: string;
  body: ReactNode;
}

/** What the person does that leaves the scrolling to them. */
const LEFT_TO_THEM = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

function PartsPage({ title, parts }: { title: string; parts: Part[] }) {
  const { pathname } = useLocation();
  const headings = useRef<Record<string, HTMLHeadingElement | null>>({});
  const asked = parts.findIndex((p) => p.at === pathname);
  useEffect(() => {
    // The first part is the top of the page: the shell gives the page's own
    // heading the focus, as on any page. A later part is gone to, and its
    // heading given the focus, which the shell then leaves where it is.
    if (asked <= 0) return;
    const part = parts[asked];
    const h = part ? headings.current[part.id] : null;
    if (!h) return;
    h.focus({ preventScroll: true });
    // The part above loads after the page is drawn, and pushes this one
    // down: kept in view as the page grows, for a moment, until the person
    // scrolls or presses a key themselves.
    let at = NaN;
    const keep = () => {
      const top = h.getBoundingClientRect().top + window.scrollY;
      if (top === at) return;
      at = top;
      h.scrollIntoView?.({ block: 'start' });
    };
    keep();
    const page = h.closest('main');
    const grows = typeof ResizeObserver === 'function' && page ? new ResizeObserver(keep) : null;
    if (grows && page) grows.observe(page);
    const stop = () => {
      grows?.disconnect();
      for (const e of LEFT_TO_THEM) window.removeEventListener(e, stop);
    };
    for (const e of LEFT_TO_THEM) window.addEventListener(e, stop, { passive: true });
    const timer = window.setTimeout(stop, 3000);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
    // Only on arriving at the address: the parts are long-lived forms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  return (
    <SettingsPage title={title}>
      {parts.map((p) => (
        <section key={p.id} id={p.id} className="settings-part stack" aria-labelledby={`${p.id}-h`}>
          <h2
            id={`${p.id}-h`}
            className="settings-part-h"
            tabIndex={-1}
            ref={(el) => {
              headings.current[p.id] = el;
            }}
          >
            {p.title}
          </h2>
          {p.body}
        </section>
      ))}
    </SettingsPage>
  );
}

/**
 * Email, in and out (/settings/email, /settings/email-in): where the
 * vault's email comes from (the SMTP server it sends through), then email
 * in (the household mailbox the family sends documents to).
 */
export function EmailInAndOutScreen() {
  return (
    <PartsPage
      title="Email, in and out"
      parts={[
        {
          at: '/settings/email',
          id: 'email-out',
          title: 'Where email comes from',
          body: <EmailOutPart />,
        },
        { at: '/settings/email-in', id: 'email-in', title: 'Email in', body: <EmailInPart /> },
      ]}
    />
  );
}

/**
 * Reading and the check (/settings/reading, /settings/reading-check): how
 * the vault reads papers — its reading model and the local AI, on or off —
 * then the Reading check, how well it reads the family's own.
 */
export function ReadingAndCheckScreen() {
  return (
    <PartsPage
      title="Reading and the check"
      parts={[
        { at: '/settings/reading', id: 'reading', title: 'Reading', body: <ReadingModelPart /> },
        {
          at: '/settings/reading-check',
          id: 'reading-check',
          title: 'Reading check',
          body: <ReadingCheckPart />,
        },
      ]}
    />
  );
}
