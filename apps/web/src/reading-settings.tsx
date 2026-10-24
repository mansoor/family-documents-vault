import type { ReadingSettings } from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { LocalAiCard } from './local-ai-settings.js';
import { Check, LoadFailed, TopBar } from './ui.js';

/**
 * Settings → For owners → Reading (0.9.0, R2): the vault's reading model,
 * on or off — an owner's. The model is a small text classifier that runs
 * on this server beside the rules and suggests a kind where the rules find
 * none; it never makes a card Ready on its own. Off, the rules read alone,
 * so the owner can run the Reading check both ways and compare.
 */
export function ReadingSettingsScreen() {
  const { authVersion, guarded } = useApp();
  const { data, error, setData, reload } = useLoad((t) => api.readingSettings(t), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const problemAt = useRef<HTMLParagraphElement>(null);

  const change = async (to: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next: ReadingSettings | null = await guarded((t) =>
        api.setReadingSettings(t, { reading_model: to }),
      );
      if (!next) return;
      flushSync(() => {
        setData(next);
        setSaid(
          next.reading_model
            ? 'Turned on. Papers read from now on are read with the reading model.'
            : 'Turned off. Papers read from now on are read by the rules alone.',
        );
      });
      status.current?.focus();
    } catch (err) {
      flushSync(() => setProblem(describeError(err)));
      problemAt.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page-top">
      <TopBar title="Reading" back="/settings/owners" backLabel="Back to For owners" />
      <p className="lede">
        How the vault reads the papers you add many at a time, from the scanner folder and from
        email.
      </p>
      <section className="card stack" aria-labelledby="reading-model-h">
        <h2 id="reading-model-h" style={{ fontSize: 18 }}>
          The vault’s reading model
        </h2>
        {data === null && error ? (
          <LoadFailed message={error} what="the reading settings" onRetry={() => void reload()} />
        ) : data === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p>
              A small model that runs on this server, beside the vault’s rules. Where the rules
              can’t tell what kind of document a paper is, it suggests one, for you to check. It
              never makes a document Ready on its own, and nothing it reads leaves the server.
            </p>
            {/* The worker has not loaded its weights (the R2 review): the rules read alone. */}
            {data.loaded === false && (
              <p className="attention" role="status">
                The reading model isn’t loaded on this server, so the rules read alone, whatever
                this is set to. Restarting the worker may bring it back; its log says why.
              </p>
            )}
            <Check
              id="reading-model"
              checked={data.reading_model}
              disabled={busy}
              label="Use the reading model"
              note="Off, the rules read alone. Run the Reading check with it on and off to compare."
              onChange={(on) => void change(on)}
            />
            <p className="muted">
              A card the model suggested a kind for says “suggested by the vault’s reading model”.
            </p>
            <p>
              <Link to="/settings/reading-check" className="btn btn-quiet">
                Run the Reading check
              </Link>
            </p>
            {busy && <p className="muted">Working…</p>}
            {problem && (
              <p ref={problemAt} className="error" role="alert" tabIndex={-1}>
                {problem}
              </p>
            )}
          </>
        )}
        <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
          {said}
        </p>
      </section>
      {/* The local AI (0.9.0, R4): set up by the operator, an owner's switch. */}
      <LocalAiCard />
    </main>
  );
}
