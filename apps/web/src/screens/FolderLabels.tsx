import { folderLabelUrl, type CabinetLayout } from '@fdv/shared';
import QRCode from 'qrcode';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { useApp, useLoad } from '../app-context.js';
import { cabinetHref } from '../cabinet.js';
import { Button, Check, ErrorNote, LoadFailed, OnTop, TopBar } from '../ui.js';

/**
 * Folder labels (0.9.0, C3; the owner's idea 5 of 13 Nov 2026): a page
 * that prints labels for the paper folders, each with the folder's name
 * and a code that opens that folder in the vault.
 *
 * The code holds the vault's own address for the folder, and nothing else:
 * no token, no secret, no title and nobody's name — only the folder's id in
 * the printer's own cabinet. Whoever scans it signs in as usual and lands on
 * the folder, if it is theirs; it shows them only what they may see.
 * Printed in the light theme, several to a page of A4 or Letter.
 */

/** The label sizes offered: how many to a sheet, and how big each is. */
const SIZES = {
  small: { label: 'Small — for a folder’s tab', across: 3, mm: { w: 63, h: 34 }, qr: 24 },
  large: { label: 'Large — for a box file or a drawer', across: 2, mm: { w: 95, h: 54 }, qr: 38 },
} as const;
type Size = keyof typeof SIZES;

const PAPERS = { a4: 'A4', letter: 'Letter' } as const;
type Paper = keyof typeof PAPERS;

interface LabelFolder {
  id: string;
  name: string;
  /** Its cabinet and drawer, said under its name when asked for. */
  where: string;
}

function labelFolders(layout: CabinetLayout | null): LabelFolder[] {
  if (!layout) return [];
  return layout.cabinets
    .filter((c) => !c.hidden)
    .flatMap((c) =>
      c.drawers
        .filter((d) => !d.hidden)
        .flatMap((d) =>
          d.folders
            .filter((f) => !f.hidden)
            .map((f) => ({ id: f.id, name: f.name, where: `${c.name} › ${d.name}` })),
        ),
    );
}

/** A QR code, drawn as one path of dark squares: no image, no canvas, nothing fetched. */
export function QrCode(props: { text: string; sizeMm: number; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = QRCode.create(props.text, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.modules.data[row * n + col]) d += `M${col + 2} ${row + 2}h1v1h-1z`;
      }
    }
    return { size: n + 4, path: d };
  }, [props.text]);
  return (
    <svg
      className="qr"
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${size} ${size}`}
      width={`${props.sizeMm}mm`}
      height={`${props.sizeMm}mm`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="var(--paper)" />
      <path d={path} fill="var(--paper-ink)" />
    </svg>
  );
}

export function FolderLabelsScreen() {
  const { authVersion } = useApp();
  const [params] = useSearchParams();
  const asked = params.get('folder');
  const mine = useLoad(async (t) => (await api.cabinet(t)).layout, [authVersion]);
  const folders = labelFolders(mine.data ?? null);
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  // At first: the folder asked for, or every folder.
  const ticked =
    chosen ??
    new Set(asked && folders.some((f) => f.id === asked) ? [asked] : folders.map((f) => f.id));
  const [size, setSize] = useState<Size>('small');
  const [paper, setPaper] = useState<Paper>('a4');
  const [withWhere, setWithWhere] = useState(false);
  const labels = folders.filter((f) => ticked.has(f.id));
  const s = SIZES[size];
  const toggle = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };

  const print = () => {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    document.body.classList.add('printing-labels');
    // Put back as the wallet card's print is (emergency.tsx): when the
    // browser says it has printed, or leaves print; else a minute later.
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    let done = false;
    const after = () => {
      if (done) return;
      done = true;
      document.body.classList.remove('printing-labels');
      if (theme) root.setAttribute('data-theme', theme);
      window.removeEventListener('afterprint', after);
      media?.removeEventListener('change', left);
      window.clearTimeout(fallback);
    };
    const left = (e: MediaQueryListEvent) => {
      if (!e.matches) after();
    };
    window.addEventListener('afterprint', after);
    media?.addEventListener('change', left);
    const fallback = window.setTimeout(after, 60_000);
    window.print();
  };

  const sheet = (
    <div
      className={`label-sheet label-sheet-${paper}`}
      style={{ gridTemplateColumns: `repeat(${s.across}, ${s.mm.w}mm)` }}
    >
      {labels.map((f) => (
        <div
          key={f.id}
          className="folder-label"
          style={{ width: `${s.mm.w}mm`, height: `${s.mm.h}mm` }}
        >
          <QrCode
            text={folderLabelUrl(window.location.origin, f.id)}
            sizeMm={s.qr}
            label={`A code that opens the folder ${f.name}`}
          />
          <div className="folder-label-words">
            <strong className="folder-label-name">{f.name}</strong>
            {withWhere && <span className="folder-label-where">{f.where}</span>}
          </div>
        </div>
      ))}
    </div>
  );

  let body;
  if (mine.error && !mine.data) {
    body = (
      <LoadFailed message={mine.error} what="your cabinet" onRetry={() => void mine.reload()} />
    );
  } else if (mine.loading && !mine.data) {
    body = <p className="muted">Opening your cabinet…</p>;
  } else if (folders.length === 0) {
    body = (
      <p className="cab-none">
        Your cabinet has no folders yet.{' '}
        <Link to={cabinetHref({ arrange: true })}>Arrange my cabinet</Link> first.
      </p>
    );
  } else {
    body = (
      <>
        <p className="lede">
          Each label has the folder’s name and a code. Scanned with a phone, the code opens that
          folder in the vault — after signing in, and only for you: it holds nothing but the
          folder’s address.
        </p>
        <fieldset className="label-folders">
          <legend>Which folders</legend>
          {folders.map((f) => (
            <Check
              key={f.id}
              id={`label-${f.id}`}
              checked={ticked.has(f.id)}
              label={`${f.where} › ${f.name}`}
              onChange={(on) => toggle(f.id, on)}
            />
          ))}
        </fieldset>
        <div className="row label-options">
          <div className="field">
            <label htmlFor="label-size">Label size</label>
            <select id="label-size" value={size} onChange={(e) => setSize(e.target.value as Size)}>
              {(Object.keys(SIZES) as Size[]).map((k) => (
                <option key={k} value={k}>
                  {SIZES[k].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="label-paper">Paper</label>
            <select
              id="label-paper"
              value={paper}
              onChange={(e) => setPaper(e.target.value as Paper)}
            >
              {(Object.keys(PAPERS) as Paper[]).map((k) => (
                <option key={k} value={k}>
                  {PAPERS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Check
          id="label-where"
          checked={withWhere}
          label="Say its cabinet and drawer under the name"
          onChange={setWithWhere}
        />
        <div className="row">
          <Button disabled={labels.length === 0} onClick={print}>
            {labels.length === 1 ? 'Print 1 label' : `Print ${labels.length} labels`}
          </Button>
        </div>
        <ErrorNote message={labels.length === 0 ? 'Tick a folder to print its label.' : null} />
        <section className="label-preview" aria-label="How the labels will look">
          {sheet}
        </section>
      </>
    );
  }

  return (
    <main className="page page-top">
      <TopBar title="Folder labels" back={cabinetHref()} backInApp />
      {body}
      {/* What the printer is given: the labels alone (styles.css, @media print). */}
      {labels.length > 0 && (
        <OnTop>
          <div className="label-print-root" aria-hidden="true">
            <style>{`@page { size: ${PAPERS[paper]}; margin: 10mm; }`}</style>
            {sheet}
          </div>
        </OnTop>
      )}
    </main>
  );
}
