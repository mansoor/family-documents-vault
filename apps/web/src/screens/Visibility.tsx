import { can, type Visibility } from '@fdv/shared';
import { useState } from 'react';
import { api } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ErrorNote, Pills } from '../ui.js';

/**
 * Who can see a document, in the three plain choices the design insists
 * on — and the sentence that has to be said when somebody picks the third
 * one (SEC-19).
 *
 * "Only you can open this. Nobody can open it after you, unless you leave
 * a key." It is a message about death, so it is brief, plain and
 * unsentimental, it appears at the moment the choice becomes true, and it
 * is never shown for that document again. The server decides whether it
 * has been said before; this screen only shows what it is given.
 */

const CHOICES: Array<{ value: Visibility; label: string; hint: string }> = [
  {
    value: 'household',
    label: 'Everyone in the family',
    hint: 'Anybody with a sign-in here can open it.',
  },
  { value: 'adults', label: 'Adults only', hint: 'The teens and viewers will not see it.' },
  { value: 'private', label: 'Only me', hint: 'Nobody else, including the owner of this vault.' },
];

export function VisibilityControl(props: {
  documentId: string;
  current: Visibility;
  isMine: boolean;
  onChanged: () => Promise<void>;
}) {
  const { guarded } = useApp();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Visibility>(props.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  if (!can(storedRole(), 'document.visibility')) return null;
  // Making something private, or taking it back, belongs to the person it
  // is about — no role changes that, so the button does not pretend.
  const choices = props.isMine ? CHOICES : CHOICES.filter((c) => c.value !== 'private');
  if (props.current === 'private' && !props.isMine) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await guarded((t) => api.setVisibility(t, props.documentId, choice));
      await props.onChanged();
      setOpen(false);
      if (result?.notice) setNotice(result.notice);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (notice) {
    return (
      <section className="card stack" role="alert" aria-labelledby="private-notice-h">
        <h2 id="private-notice-h" style={{ fontSize: 18 }}>
          {notice.title}
        </h2>
        <p>{notice.body}</p>
        <Button onClick={() => setNotice(null)}>I understand</Button>
      </section>
    );
  }

  if (!open) {
    return (
      <Button kind="link" onClick={() => setOpen(true)}>
        Change who can see this
      </Button>
    );
  }

  return (
    <section className="card stack">
      <Pills
        label="Who can see this"
        value={choice}
        options={choices.map((c) => ({ value: c.value, label: c.label }))}
        onChange={setChoice}
      />
      <p className="muted">{choices.find((c) => c.value === choice)?.hint}</p>
      <ErrorNote message={error} />
      <div className="row">
        <Button disabled={busy || choice === props.current} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
