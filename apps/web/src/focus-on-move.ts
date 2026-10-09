import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * A page's heading, given the focus: a screen reader says where somebody
 * is, and the next Tab is the page's first stop. It is made focusable for
 * the purpose (`tabindex="-1"`), which leaves it out of the Tab order.
 */
export function focusHeading(within: ParentNode = document): boolean {
  const heading =
    within.querySelector<HTMLElement>('main h1') ?? within.querySelector<HTMLElement>('h1');
  if (!heading) return false;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  return true;
}

/**
 * A move to another page that left the focus nowhere — on the page the
 * button that moved it was taken away with — gives it to the new page's
 * heading (WCAG 2.4.3, R5). Inside the shell, the shell does this for every
 * move but the first (shell.tsx); this is for the rest: Welcome to Sign in,
 * signing in to Home (the shell's first page), signing out, the setup's
 * steps. A screen that put the focus somewhere itself is left as it is,
 * and so is the first page loaded: a page opened starts at its top.
 */
export function FocusOnMove() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After the new page's own effects, and the shell's: only where none of
    // them put the focus.
    const timer = window.setTimeout(() => {
      const now = document.activeElement;
      if (now === null || now === document.body) focusHeading();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  return null;
}
