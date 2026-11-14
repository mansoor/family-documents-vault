import { sensitiveStillSharedWords } from '@fdv/shared';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ApiRequestError } from './api.js';
import { describeError } from './app-context.js';
import { ConfirmDialog, ErrorNote } from './ui.js';

/**
 * Asked before a sensitive document goes outside the family (0.9.0, H1a):
 * a link to it, a collection's link with it ticked, or a collection whose
 * link keeps up with it. `ask(run)` runs `run(false)`; answered `409
 * sensitive_confirm`, it shows the vault's own question, and on Yes runs
 * `run(true)` — which sends `confirm_sensitive: true`. Cancel is an answer:
 * nothing is sent, and `ask` gives null. With `first`, the question is asked
 * before anything is sent, in those words, for a document the screen
 * already knows is sensitive.
 */
export function useSensitiveConfirm(words: { title: string; confirmLabel: string }): {
  ask: <T>(run: (confirmed: boolean) => Promise<T>, first?: string | null) => Promise<T | null>;
  dialog: ReactNode;
} {
  const [asking, setAsking] = useState<string | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const question = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setAsking(message);
      }),
    [],
  );
  const done = (yes: boolean) => {
    const resolve = answer.current;
    answer.current = null;
    setAsking(null);
    resolve?.(yes);
  };
  const ask = useCallback(
    async <T,>(run: (confirmed: boolean) => Promise<T>, first?: string | null) => {
      if (first) {
        if (!(await question(first))) return null;
        return run(true);
      }
      try {
        return await run(false);
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.code !== 'sensitive_confirm') throw err;
        if (!(await question(err.message))) return null;
        return run(true);
      }
    },
    [question],
  );
  const dialog =
    asking !== null ? (
      <ConfirmDialog
        title={words.title}
        confirmLabel={words.confirmLabel}
        onConfirm={() => done(true)}
        onCancel={() => done(false)}
      >
        {asking}
      </ConfirmDialog>
    ) : null;
  return { ask, dialog };
}

/**
 * A paper made sensitive while links outside the family still give it
 * (0.9.0, H1a): asked once the edit is saved — never in its way. Keep them
 * leaves them; End them now ends them (`onEnd`, which answers what it did,
 * in words), and says so before the screen moves on.
 */
export function StillSharedDialog(props: {
  links: number;
  onEnd: () => Promise<string>;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<'ask' | 'ending' | { said: string }>('ask');
  const [error, setError] = useState<string | null>(null);
  if (typeof phase === 'object') {
    return (
      <ConfirmDialog
        title="Sharing ended"
        confirmLabel="Done"
        cancelLabel={null}
        onConfirm={props.onDone}
        onCancel={props.onDone}
      >
        {phase.said}
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      title="Still shared outside the family"
      confirmLabel="End them now"
      busyLabel="Ending…"
      busy={phase === 'ending'}
      cancelLabel="Keep them"
      onConfirm={() => {
        setPhase('ending');
        setError(null);
        props.onEnd().then(
          (said) => setPhase({ said }),
          (err: unknown) => {
            setError(describeError(err));
            setPhase('ask');
          },
        );
      }}
      onCancel={props.onDone}
    >
      {sensitiveStillSharedWords(props.links)}
      <ErrorNote message={error} />
    </ConfirmDialog>
  );
}
