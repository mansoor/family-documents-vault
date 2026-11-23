import { type IssuerGroup, type IssuerSameAs } from '@fdv/shared';
import { useId, useRef, useState, type RefObject } from 'react';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { issuersChanged, useIssuersVersion } from '../issuer-store.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { Button, ErrorNote, Sheet, TopBar } from '../ui.js';

/**
 * Settings → Who issued it (0.9.0-dev.91): the household's "Same as" list.
 * The same bank or company is often written several ways ("Barclays",
 * "Barclays Bank UK"); here an owner or adult says which are one, and the
 * cabinet, its dividers and the Who issued it filter treat them as one. No
 * document is changed.
 *
 *  - These look like one: what the vault suggests (the leading words of one
 *    are the other), each with Same and Separate; never joined by itself,
 *    and one said to be separate is not suggested again.
 *  - Every issuer: each with how many papers, the other spellings said to
 *    be the same as it, each with Separate, and Same as… to join it to
 *    another by hand, chosen in one sheet whichever row asked.
 *
 * Every name and count is from the papers the person can read. After any
 * change the list is read again, here and everywhere issuers are named.
 */

/** "1 paper", "3 papers". */
const papers = (n: number) => `${n} paper${n === 1 ? '' : 's'}`;

export function IssuersScreen() {
  const { withToken, authVersion } = useApp();
  // Owners and adults keep the list (the menu offers it only where the vault keeps one).
  const role = storedRole();
  const may = role === 'owner' || role === 'adult';
  const changes = useIssuersVersion();
  const backToSettings =
    useShellMode() === 'phone' ? { back: '/settings', backLabel: 'Back to Settings' } : {};
  const { data: groups, error } = useLoad(
    async (t) => (may ? await api.issuerGroups(t) : null),
    [authVersion, may, changes],
  );
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The issuer whose Same as… sheet is open; the button that opened it. */
  const [joining, setJoining] = useState<IssuerGroup | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  const change = async (
    how: 'same' | 'separate',
    from: string,
    to: string,
    words: string,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      await withToken((t) =>
        how === 'same' ? api.sameIssuer(t, { from, to }) : api.separateIssuer(t, { from, to }),
      );
      // Read again, here and wherever issuers are named.
      issuersChanged();
      setSaid(words);
      window.setTimeout(() => status.current?.focus(), 0);
      return true;
    } catch (err) {
      setProblem(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!may) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="Who issued it" {...backToSettings} />
        <p className="status status-warn">Only owners and adults say which issuers are the same.</p>
      </main>
    );
  }

  const items = groups?.items ?? [];
  return (
    <main className="page page-top has-nav">
      <TopBar title="Who issued it" {...backToSettings} />
      <p className="lede">
        The same bank or company is often written several ways. Say which are the same, and your
        cabinet, its dividers and the Who issued it filter treat them as one, for everybody in the
        family. No document is changed.
      </p>
      <p role="status" ref={status} tabIndex={-1} className="notice status-line">
        {said}
      </p>
      <ErrorNote message={problem ?? error} />
      {groups && groups.same_as.length > 0 && (
        <section aria-labelledby="issuers-like-h">
          <h2 id="issuers-like-h" className="section-h">
            These look like one
          </h2>
          <ul className="list issuer-list">
            {groups.same_as.map((s) => (
              <SameAsRow
                key={`${s.from.key}\n${s.to.key}`}
                same={s}
                busy={busy}
                onSame={() =>
                  void change(
                    'same',
                    s.from.key,
                    s.to.key,
                    `“${s.from.name}” is now the same issuer as “${s.to.name}”.`,
                  )
                }
                onSeparate={() =>
                  void change(
                    'separate',
                    s.from.key,
                    s.to.key,
                    `“${s.from.name}” and “${s.to.name}” are kept separate.`,
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="issuers-all-h">
        <h2 id="issuers-all-h" className="section-h">
          Every issuer
        </h2>
        {groups && items.length === 0 && (
          <p className="muted">
            No document you can see says who issued it yet. Add it on a document’s page.
          </p>
        )}
        <ul className="list issuer-list">
          {items.map((g) => (
            <IssuerRow
              key={g.key}
              group={g}
              busy={busy}
              canJoin={items.length > 1}
              onSameAs={(button) => {
                opener.current = button;
                setJoining(g);
              }}
              onSeparate={(member) =>
                void change(
                  'separate',
                  member.key,
                  g.key,
                  `“${member.name}” is separate from “${g.name}” again.`,
                )
              }
            />
          ))}
        </ul>
      </section>
      {joining && (
        <SameAsSheet
          group={joining}
          others={items.filter((x) => x.key !== joining.key)}
          busy={busy}
          returnFocus={opener}
          onCancel={() => setJoining(null)}
          onSame={async (to) => {
            const done = await change(
              'same',
              joining.key,
              to.key,
              `“${joining.name}” is now the same issuer as “${to.name}”.`,
            );
            if (done) setJoining(null);
          }}
        />
      )}
    </main>
  );
}

/** A suggestion: two issuers that look like one, and Same or Separate. */
function SameAsRow(props: {
  same: IssuerSameAs;
  busy: boolean;
  onSame: () => void;
  onSeparate: () => void;
}) {
  const { from, to } = props.same;
  return (
    <li>
      <span>
        “{to.name}” ({papers(to.count)}) and “{from.name}” ({papers(from.count)}) look like one.
      </span>
      <span className="row" style={{ gap: 4 }}>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={props.busy}
          aria-label={`Same: “${from.name}” is “${to.name}”`}
          onClick={props.onSame}
        >
          Same
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          disabled={props.busy}
          aria-label={`Separate: keep “${from.name}” and “${to.name}” apart`}
          onClick={props.onSeparate}
        >
          Separate
        </button>
      </span>
    </li>
  );
}

/** One issuer: its papers, the spellings said to be the same as it, and Same as… another. */
function IssuerRow(props: {
  group: IssuerGroup;
  busy: boolean;
  canJoin: boolean;
  onSameAs: (button: HTMLButtonElement | null) => void;
  onSeparate: (member: { key: string; name: string }) => void;
}) {
  const { group } = props;
  const button = useRef<HTMLButtonElement>(null);
  return (
    <li className="issuer-row">
      <div>
        <span className="doc-title">{group.name}</span>{' '}
        <span className="muted">{papers(group.count)}</span>
        {group.members.length > 0 && (
          <ul className="issuer-members" aria-label={`Also written as, for ${group.name}`}>
            {group.members.map((m) => (
              <li key={m.key}>
                <span>
                  {m.name} <span className="muted">{papers(m.count)}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  disabled={props.busy}
                  aria-label={`Separate “${m.name}” from “${group.name}”`}
                  onClick={() => props.onSeparate(m)}
                >
                  Separate
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.canJoin && (
        <button
          ref={button}
          type="button"
          className="btn btn-quiet btn-small"
          disabled={props.busy}
          aria-label={`Same as… for ${group.name}`}
          onClick={() => props.onSameAs(button.current)}
        >
          Same as…
        </button>
      )}
    </li>
  );
}

/** The one sheet that says which issuer another is the same as, whichever row asked. */
function SameAsSheet(props: {
  group: IssuerGroup;
  others: IssuerGroup[];
  busy: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onSame: (to: IssuerGroup) => void | Promise<void>;
}) {
  const titleId = useId();
  const pickId = useId();
  const [to, setTo] = useState('');
  const chosen = props.others.find((o) => o.key === to);
  return (
    <Sheet
      labelledBy={titleId}
      busy={props.busy}
      returnFocus={props.returnFocus}
      onClose={props.onCancel}
    >
      <h2 id={titleId}>“{props.group.name}” is the same as…</h2>
      <p className="muted">
        Its papers join the issuer you choose, in every cabinet and filter, for everybody in the
        family. No document is changed, and Separate undoes it.
      </p>
      <div className="field">
        <label htmlFor={pickId}>Same as</label>
        <select id={pickId} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose an issuer…</option>
          {props.others.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name} ({papers(o.count)})
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <Button
          kind="primary"
          disabled={!chosen || props.busy}
          onClick={() => {
            if (chosen) void props.onSame(chosen);
          }}
        >
          Same
        </Button>
        <Button kind="quiet" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
