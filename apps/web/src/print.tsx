import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useApp } from './app-context.js';
import { exactWords, useFamilyZone } from './family-time.js';
import { applyTheme } from './theme.js';
import { ConfirmDialog, OnTop } from './ui.js';

/**
 * Printing (0.9.0; the owner's backlog of 19 Nov 2026: "There's no print
 * option anywhere today"): a document, a note, a collection's contents and
 * the activity log, each from a Print beside the page's other actions.
 *
 * What is printed is drawn here, in a root of its own at the end of the
 * page, and only while it is printed: the printer is given that root and
 * nothing else (styles.css, `body.printing`) — no bar, no sidebar, no
 * buttons, no toast — in the light theme, whatever the app's. It holds
 * only what the screen shows the reader, as the screen says it: nothing is
 * asked of the vault that the page could not ask, and nothing secret is on
 * it (no link, no PIN, no code). A footer says whose vault it is and when
 * it was printed, on the family's clock. As the wallet card and the folder
 * labels print.
 *
 * Anything Sensitive (the owner's choice of 24 Nov 2026) still prints, with
 * no more asked of who is printing: its heading says Sensitive, and before
 * it is printed one notice says to keep the printout safe and shred it,
 * with Print and Cancel — Cancel printing nothing.
 */

/** Said before anything Sensitive is printed. */
export const SENSITIVE_PRINT_NOTICE =
  'This is marked Sensitive. Keep the printout somewhere safe and shred it when you no longer need it.';

/** The page's class while it is printed. */
export const PRINTING = 'printing';

/**
 * The browser's Print, with only the print root on paper, in the light
 * theme. Put back once the printer has it: when the browser says it has
 * printed, or leaves print. A phone's browser returns from print() at once
 * and prints later, so nothing is put back before then — but for a browser
 * that says neither, a minute later. Resolves once put back.
 */
export function printNow(): Promise<void> {
  return new Promise((resolve) => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.body.classList.add(PRINTING);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    let done = false;
    const after = () => {
      if (done) return;
      done = true;
      document.body.classList.remove(PRINTING);
      // The theme as chosen now, never as it was found: a second print
      // begun before the first ended found it light.
      applyTheme();
      window.removeEventListener('afterprint', after);
      media?.removeEventListener?.('change', left);
      window.clearTimeout(fallback);
      resolve();
    };
    const left = (e: MediaQueryListEvent) => {
      if (!e.matches) after();
    };
    window.addEventListener('afterprint', after);
    media?.addEventListener?.('change', left);
    const fallback = window.setTimeout(after, 60_000);
    window.print();
  });
}

/** Until each picture in `root` can be drawn: ten seconds at most, so a picture that never comes holds nothing up. */
async function picturesReady(root: HTMLElement | null): Promise<void> {
  const pictures = [...(root?.querySelectorAll('img') ?? [])];
  if (pictures.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(
      pictures.map((img) =>
        typeof img.decode === 'function'
          ? img.decode().catch(() => undefined)
          : Promise.resolve(undefined),
      ),
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 10_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * What is printed, and the printing of it: drawn at the end of the page
 * (never on the screen), its pictures waited for, then the browser's Print;
 * `onDone` once the printer has it. A heading, what it is (`about`), the
 * body, and the footer: the vault's name and when it was printed.
 */
export function PrintOut(props: {
  title: string;
  about?: ReactNode;
  children: ReactNode;
  onDone: () => void;
}) {
  const { caps } = useApp();
  const zone = useFamilyZone();
  const root = useRef<HTMLDivElement>(null);
  const [at] = useState(() => new Date().toISOString());
  const onDone = useRef(props.onDone);
  useEffect(() => {
    onDone.current = props.onDone;
  });
  useEffect(() => {
    let stopped = false;
    void (async () => {
      await picturesReady(root.current);
      if (stopped) return;
      await printNow();
      if (!stopped) onDone.current();
    })();
    return () => {
      stopped = true;
    };
  }, []);
  const vault = caps?.branding.display_name ?? 'Family Document Vault';
  return (
    <OnTop>
      <div ref={root} className="print-root" aria-hidden="true">
        <header className="print-head">
          <h1>{props.title}</h1>
          {props.about}
        </header>
        {props.children}
        <footer className="print-foot">
          {vault} · Printed {exactWords(at, zone)}
        </footer>
      </div>
    </OnTop>
  );
}

/**
 * The notice before a Sensitive note is printed: Print goes on, Cancel
 * prints nothing. The app's own "are you sure?", so its focus starts on
 * Cancel and goes back to Print once it is answered.
 */
export function SensitivePrintNotice(props: {
  returnFocus?: RefObject<HTMLElement | null>;
  onPrint: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title="Before you print"
      confirmLabel="Print"
      {...(props.returnFocus ? { returnFocus: props.returnFocus } : {})}
      onConfirm={props.onPrint}
      onCancel={props.onCancel}
    >
      <p>{SENSITIVE_PRINT_NOTICE}</p>
    </ConfirmDialog>
  );
}

/** A printed table's empty cell: a dash, as the screen's. */
export const NOTHING = '—';
