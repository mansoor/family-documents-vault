import { PREVIEW_MAX_PAGES } from '@fdv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { Button, ErrorNote, TopBar } from '../ui.js';

/** How much larger than "fit to the window" a page can be made. */
const ZOOMS = [1, 1.5, 2, 3] as const;
/** About two minutes of "being made" before it stops asking by itself. */
const PATIENCE = 40;

type PageState =
  | { kind: 'loading' }
  | { kind: 'shown'; url: string }
  | { kind: 'making' }
  | { kind: 'slow' }
  | { kind: 'none'; message: string }
  | { kind: 'not_confirmed' }
  | { kind: 'failed'; message: string };

/**
 * Reading a document (0.4.12): its pages as the vault drew them, one at a
 * time — fit to the window, larger when asked, turned with the arrows or
 * the arrow keys. Tapping the small preview on the document opens this.
 *
 * Every page fetched is written in the activity log, so nothing is fetched
 * ahead of being looked at.
 */
export function ReaderScreen() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { guarded, authVersion } = useApp();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [doc, versions] = await Promise.all([
        api.document(t, id as string),
        api.versions(t, id as string),
      ]);
      return { doc, versions: versions.items };
    },
    [id, authVersion],
  );
  const version = data
    ? (data.versions.find((v) => v.id === params.get('v')) ?? data.versions[0])
    : undefined;
  const versionId = version?.id;
  const pageNo = Math.max(1, Math.floor(Number(params.get('p'))) || 1);
  const known = version ? (version.preview_pages ?? version.page_count) : null;
  const total = known ? Math.min(known, PREVIEW_MAX_PAGES) : null;
  const title = data?.doc.title ?? 'the document';

  const [zoom, setZoom] = useState(0);
  const [attempt, setAttempt] = useState(0);
  // What was last heard, and which page (and try) it was about: anything
  // else is still on its way.
  const [heard, setHeard] = useState<{ key: string; state: PageState } | null>(null);
  const key = `${versionId}|${pageNo}|${attempt}`;
  const page: PageState = heard?.key === key ? heard.state : { kind: 'loading' };
  const recounted = useRef<string | null>(null);

  const go = useCallback(
    (n: number) => {
      if (!versionId || n < 1 || (total !== null && n > total)) return;
      setParams({ v: versionId, p: String(n) }, { replace: true });
    },
    [versionId, total, setParams],
  );

  // The page itself: asked for once, and again while it is being drawn.
  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    let url: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setPage = (state: PageState) => setHeard({ key, state });
    const tryOnce = async (tries: number) => {
      try {
        // An Essential or an "only me" document may ask who is asking first.
        const blob = await guarded((t) => api.page(t, versionId, pageNo));
        if (cancelled) return;
        if (!blob) {
          setPage({ kind: 'not_confirmed' });
          return;
        }
        url = URL.createObjectURL(blob);
        setPage({ kind: 'shown', url });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.code === 'preview_pending') {
          if (tries >= PATIENCE) {
            setPage({ kind: 'slow' });
            return;
          }
          setPage({ kind: 'making' });
          timer = setTimeout(() => void tryOnce(tries + 1), (err.retryAfterSeconds ?? 3) * 1000);
          return;
        }
        if (err instanceof ApiRequestError && err.code === 'no_preview') {
          setPage({ kind: 'none', message: err.message });
          return;
        }
        setPage({ kind: 'failed', message: describeError(err) });
      }
    };
    void tryOnce(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [versionId, pageNo, key, guarded]);

  // Drawn just now: the version knows how many pages there are. Once.
  useEffect(() => {
    if (page.kind !== 'shown' || !version || version.preview_pages != null) return;
    if (recounted.current === version.id) return;
    recounted.current = version.id;
    void reload();
  }, [page.kind, version, reload]);

  // The keys a reader reaches for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(pageNo + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(pageNo - 1);
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
      else if (e.key === '-') setZoom((z) => Math.max(0, z - 1));
      else if (e.key === 'Escape') void navigate(`/documents/${id}`);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, pageNo, navigate, id]);

  const download = async () => {
    if (!version) return;
    try {
      const blob = await guarded((t) => api.content(t, version.id));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = version.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setHeard({ key, state: { kind: 'failed', message: describeError(err) } });
    }
  };
  const again = () => setAttempt((n) => n + 1);

  return (
    <main className="page page-top reader">
      <TopBar title={data?.doc.title ?? 'Document'} back={`/documents/${id}`} />
      <ErrorNote message={error} />
      {version && (
        <>
          <div className="reader-tools" role="toolbar" aria-label="Pages">
            <Button
              kind="quiet"
              ariaLabel="Previous page"
              disabled={pageNo <= 1}
              onClick={() => go(pageNo - 1)}
            >
              ‹
            </Button>
            <span className="reader-count" aria-live="polite">
              {total ? `Page ${pageNo} of ${total}` : `Page ${pageNo}`}
            </span>
            <Button
              kind="quiet"
              ariaLabel="Next page"
              disabled={total !== null && pageNo >= total}
              onClick={() => go(pageNo + 1)}
            >
              ›
            </Button>
            <span className="reader-gap" />
            <Button
              kind="quiet"
              ariaLabel="Smaller"
              disabled={zoom === 0}
              onClick={() => setZoom((z) => Math.max(0, z - 1))}
            >
              −
            </Button>
            <Button
              kind="quiet"
              ariaLabel="Larger"
              disabled={zoom === ZOOMS.length - 1}
              onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
            >
              +
            </Button>
          </div>
          {/* Focusable, so the keyboard can scroll a page made larger. */}
          <div
            className={zoom ? 'reader-page zoomed' : 'reader-page'}
            tabIndex={0}
            role="region"
            aria-label={`Page ${pageNo}`}
          >
            {page.kind === 'shown' ? (
              <img
                src={page.url}
                alt={`Page ${pageNo} of ${title}`}
                style={zoom ? { width: `${(ZOOMS[zoom] ?? 1) * 100}%` } : undefined}
              />
            ) : page.kind === 'loading' ? (
              <span className="muted">Opening the page…</span>
            ) : page.kind === 'making' ? (
              <span className="muted">Preview is being made…</span>
            ) : page.kind === 'slow' ? (
              <div className="reader-note">
                <p>The preview is taking longer than usual.</p>
                <Button kind="quiet" onClick={again}>
                  Try again
                </Button>
              </div>
            ) : page.kind === 'none' ? (
              <div className="reader-note">
                <p>{page.message}</p>
                <Button onClick={() => void download()}>Download</Button>
              </div>
            ) : page.kind === 'not_confirmed' ? (
              <div className="reader-note">
                <p>Confirm it's you to see this page.</p>
                <Button kind="quiet" onClick={again}>
                  Try again
                </Button>
              </div>
            ) : (
              <div className="reader-note">
                <ErrorNote message={page.message} />
                <Button kind="quiet" onClick={again}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}
