import {
  COLLECTION_MANAGER_SWITCHES,
  COLLECTION_MANAGERS_ALWAYS,
  type Capabilities,
  type CollectionManager,
  type CollectionManagers,
  type CollectionPowers,
  type Role,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, Check, ConfirmDialog, ErrorNote, Select } from './ui.js';

/**
 * A collection's managers on the web (0.9.0, the owner's decision of 13 Nov
 * 2026): who besides its maker manages it, and what each may do besides
 * what every manager may. Its maker — or a manager they let choose managers
 * — picks somebody of the family who can see it already, turns each switch
 * on or off, and takes a manager away, asked first. A switch the reader
 * may not do themselves is never offered to turn on; the vault decides
 * regardless.
 */

type SwitchKey = (typeof COLLECTION_MANAGER_SWITCHES)[number]['key'];
type Switches = Record<SwitchKey, boolean>;

const NONE: Switches = {
  may_change_audience: false,
  may_delete: false,
  may_choose_managers: false,
};

/** Which of the reader's own powers each switch asks of them. */
const POWER_OF: Record<SwitchKey, keyof CollectionPowers> = {
  may_change_audience: 'change_audience',
  may_delete: 'delete',
  may_choose_managers: 'choose_managers',
};

/** Whether the Managers section is drawn: the vault has them, and the reader is of the family. */
export function managersOffered(caps: Capabilities | null, role: Role): boolean {
  return (
    caps?.features.collection_managers === true &&
    (role === 'owner' || role === 'adult' || role === 'teen')
  );
}

/** "Can also delete it and choose managers", or "Can add and remove documents, and rename it". */
export function managerWords(m: Pick<CollectionManager, SwitchKey>): string {
  const also = COLLECTION_MANAGER_SWITCHES.filter((s) => m[s.key]).map((s) =>
    s.label.replace(/^Can also /, ''),
  );
  if (also.length === 0) return 'Can add and remove documents, and rename it';
  const words =
    also.length === 1
      ? also[0]
      : `${also.slice(0, -1).join(', ')} and ${also[also.length - 1] as string}`;
  return `Can also ${words}`;
}

export function ManagersSection(props: {
  collectionId: string;
  collectionName: string;
  /** Loaded again when the collection changes (who it is for drops managers). */
  version: string;
  /** Something changed here: the collection is loaded again. */
  onChanged: () => void;
}) {
  const { withToken, authVersion } = useApp();
  const { data, error, setData } = useLoad(
    (t) => api.collectionManagers(t, props.collectionId),
    [props.collectionId, props.version, authVersion],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [person, setPerson] = useState('');
  const [asked, setAsked] = useState<Switches>(NONE);
  const [removing, setRemoving] = useState<CollectionManager | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const heading = useRef<HTMLHeadingElement>(null);
  // Where the focus goes back to when the question is closed: the row's Remove.
  const returnTo = useRef<HTMLElement | null>(null);

  if (!data) {
    return error ? <ErrorNote message={error} /> : null;
  }
  const powers = data.my_powers;
  const chooses = powers.choose_managers;
  // An owner, while its maker may no longer change it, may take managers away.
  const removes = powers.remove_managers;
  // Nobody to tell of, and nothing the reader may do: no section.
  if (!chooses && !removes && data.items.length === 0) return null;
  /** A switch the reader may turn on: one they may do themselves, or any, as its maker. */
  const mayGive = (s: SwitchKey) => powers.maker || powers[POWER_OF[s]];

  const run = async (
    what: (t: string) => Promise<CollectionManagers | void>,
    said: string,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await withToken(what);
      if (answer) setData(answer);
      else setData(await withToken((t) => api.collectionManagers(t, props.collectionId)));
      setNote(said);
      props.onChanged();
      return true;
    } catch (err) {
      setProblem(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const who = data.eligible.find((e) => e.member_id === person);
    if (!who) {
      setProblem('Choose who will manage it.');
      return;
    }
    const done = await run(
      (t) =>
        api.addCollectionManager(t, props.collectionId, { member_id: who.member_id, ...asked }),
      `${who.display_name} now manages “${props.collectionName}”.`,
    );
    if (done) {
      setPerson('');
      setAsked(NONE);
    }
  };

  const toggle = (m: CollectionManager, s: SwitchKey, on: boolean) =>
    void run(
      (t) => api.updateCollectionManager(t, props.collectionId, m.member_id, { [s]: on }),
      `${m.display_name}: ${managerWords({ ...m, [s]: on }).toLowerCase()}.`,
    );

  const remove = async (m: CollectionManager) => {
    await run(
      (t) => api.removeCollectionManager(t, props.collectionId, m.member_id),
      `${m.display_name} no longer manages “${props.collectionName}”.`,
    );
    setRemoving(null);
    heading.current?.focus();
  };

  return (
    <section className="card stack collection-managers" aria-labelledby="collection-managers-h">
      <h2 id="collection-managers-h" ref={heading} tabIndex={-1}>
        Managers
      </h2>
      <p className="muted">
        {COLLECTION_MANAGERS_ALWAYS} {chooses ? 'Turn on anything more each of them may do.' : ''}
      </p>
      <p role="status" className="notice status-line">
        {note}
      </p>
      <ErrorNote message={problem} />
      {data.items.length === 0 ? (
        <p className="muted">Nobody else manages it yet.</p>
      ) : (
        <ul className="list" aria-label="Managers">
          {data.items.map((m) => (
            <li key={m.member_id} className="stack">
              <strong>{m.display_name}</strong>
              {chooses ? (
                COLLECTION_MANAGER_SWITCHES.map((s) => (
                  <Check
                    key={s.key}
                    id={`manager-${m.member_id}-${s.key}`}
                    label={`${s.label} (${m.display_name})`}
                    checked={m[s.key]}
                    // Turning on what the reader may not do is never offered.
                    disabled={busy || (!m[s.key] && !mayGive(s.key))}
                    onChange={(on) => toggle(m, s.key, on)}
                  />
                ))
              ) : (
                <span className="muted">{managerWords(m)}</span>
              )}
              {/* Taken away by whoever may choose managers, and by an owner
                  while its maker may no longer change it (0.9.0). */}
              {removes && (
                <Button
                  kind="quiet"
                  danger
                  disabled={busy}
                  ref={(b) => {
                    removeButtons.current.set(m.member_id, b);
                  }}
                  ariaLabel={`Remove ${m.display_name} as a manager`}
                  onClick={() => {
                    returnTo.current = removeButtons.current.get(m.member_id) ?? null;
                    setRemoving(m);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {chooses &&
        (data.eligible.length === 0 ? (
          <p className="muted">
            Nobody else can manage it: a manager is someone in the family with a sign-in who can
            already see it.
          </p>
        ) : (
          <div className="stack">
            <Select
              id="new-manager"
              label="Make someone a manager"
              value={person}
              options={[
                { value: '', label: 'Choose someone' },
                ...data.eligible.map((e) => ({ value: e.member_id, label: e.display_name })),
              ]}
              hint="Someone in the family who can already see this collection."
              onChange={setPerson}
            />
            {COLLECTION_MANAGER_SWITCHES.filter((s) => mayGive(s.key)).map((s) => (
              <Check
                key={s.key}
                id={`new-manager-${s.key}`}
                label={s.label}
                checked={asked[s.key]}
                disabled={busy}
                onChange={(on) => setAsked((a) => ({ ...a, [s.key]: on }))}
              />
            ))}
            <div className="row">
              <Button disabled={busy || person === ''} onClick={() => void add()}>
                {busy ? 'Saving…' : 'Make a manager'}
              </Button>
            </div>
          </div>
        ))}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.display_name} as a manager?`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={returnTo}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        >
          <p>
            {removing.display_name} will still see “{props.collectionName}”, but will no longer be
            able to change it.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
