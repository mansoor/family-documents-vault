import { caregiverLookWords, type CaregiverGrantView, type GrownUpQuestionView } from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError, type Member } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateTimeWords } from './family-time.js';
import { SettingsPage } from './screens/Settings.js';
import { Button, ConfirmDialog, ErrorNote, LoadFailed, Select } from './ui.js';

/**
 * Caregivers for somebody's medical papers, and turning 18 (0.9.0, H1b of
 * the health plan; `features.caregivers`).
 *
 *  - On a person's page, and in the person's own Settings: "Caregivers" —
 *    let someone see my medical papers, the list, Keep and Revoke; for the
 *    caregiver, Stop seeing them; for the person, who looked and when.
 *  - On Home: the one question somebody is asked as they turn 18, and the
 *    owners' card to ask somebody with no sign-in in person.
 *
 * Plain words, no ids: the vault and the database decide who may do what;
 * this only draws what would not be refused.
 */

/** "Ahmed can see your medical papers, Only me ones included." */
function grantWords(g: CaregiverGrantView, mine: boolean, name: string): string {
  const whose = mine ? 'your' : `${name}’s`;
  if (g.confirmed) return `Can see ${whose} medical papers, Only me ones included.`;
  return mine
    ? `Named by ${g.granted_by_name ?? 'an owner'}. They see what the family sees until you keep them; keep them to include your Only me papers.`
    : `Named by ${g.granted_by_name ?? 'an owner'}. ${name} can keep this once they have their own sign-in.`;
}

/**
 * "Caregivers" on a person's page: for the person, an owner, or one of
 * their caregivers. Nothing for anybody else — the vault refuses them, and
 * the card is not drawn.
 */
export function CaregiversCard(props: {
  member: Member;
  name: string;
  /** The reader is an owner: told who looked at the person's papers, never which (H1b). */
  owner?: boolean;
}) {
  const { authVersion, withToken, caps } = useApp();
  const offered = caps?.features.caregivers === true && props.member.kind !== 'guest';
  const mine = props.member.is_me;
  const readsLooks = mine || props.owner === true;
  const { data, error, reload } = useLoad(
    async (t) => {
      if (!offered) return null;
      const grants = await api.caregiversOf(t, props.member.id).catch((err: unknown) => {
        // Not theirs to see (or no longer, given up): nothing drawn.
        if (err instanceof ApiRequestError && err.status === 403) return null;
        throw err;
      });
      const looks =
        readsLooks && grants
          ? (await api.caregiverLooks(t, props.member.id).catch(() => ({ items: [] }))).items
          : [];
      return { grants, looks };
    },
    [authVersion, props.member.id, offered, readsLooks],
  );
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [ending, setEnding] = useState<CaregiverGrantView | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  if (!offered) return null;
  if (data === null && error) {
    return <LoadFailed message={error} what="the caregivers" onRetry={() => void reload()} />;
  }
  if (!data?.grants) return null;
  const { grants, looks } = data;
  if (!mine && grants.items.length === 0 && !grants.may_add && looks.length === 0) return null;

  const run = async (fn: (t: string) => Promise<unknown>, after: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      await withToken(fn);
      await reload();
      setSaid(after);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) {
      setProblem('Choose who can see them.');
      return;
    }
    const who = grants.candidates.find((c) => c.member_id === chosen)?.display_name ?? 'They';
    await run(
      (t) => api.nameCaregiver(t, props.member.id, chosen),
      mine
        ? `${who} can now see your medical papers.`
        : `${who} can now see ${props.name}’s medical papers that the family sees.`,
    );
    setChosen('');
  };
  const endWords = (g: CaregiverGrantView) =>
    g.may_give_up && !g.may_revoke
      ? {
          title: `Stop seeing ${g.person_name}’s medical papers?`,
          body: `You won’t see ${g.person_name}’s Only me medical papers any more. ${g.person_name} can name you again.`,
          confirm: 'Stop seeing them',
          after: `You no longer see ${g.person_name}’s medical papers.`,
        }
      : {
          title: `Stop ${g.caregiver_name} seeing ${mine ? 'your' : `${props.name}’s`} medical papers?`,
          body: `${g.caregiver_name} won’t see ${mine ? 'your' : `${props.name}’s`} Only me medical papers any more, from now.`,
          confirm: 'Revoke',
          after: `${g.caregiver_name} no longer sees ${mine ? 'your' : `${props.name}’s`} medical papers.`,
        };

  return (
    <section aria-labelledby="caregivers-h" className="stack caregivers">
      <h2 id="caregivers-h" className="section-h">
        Caregivers
      </h2>
      <p className="muted">
        {mine
          ? 'Someone you name can see your medical papers, your Only me ones included. They can’t change or share them, and you can see when they look.'
          : `Someone named here can see ${props.name}’s medical papers. They can’t change or share them.`}
      </p>
      {grants.items.length === 0 ? (
        <p className="muted">Nobody yet.</p>
      ) : (
        <ul className="list">
          {grants.items.map((g) => (
            <li key={g.id}>
              <span>
                <strong>{g.caregiver_name}</strong>
                <span className="muted">{grantWords(g, mine, props.name)}</span>
              </span>
              <span className="row">
                {g.may_keep && (
                  <Button
                    kind="quiet"
                    disabled={busy}
                    ariaLabel={`Keep ${g.caregiver_name}`}
                    onClick={() =>
                      void run(
                        (t) => api.keepCaregiver(t, props.member.id, g.caregiver_member_id),
                        `${g.caregiver_name} can now see your medical papers, Only me ones included.`,
                      )
                    }
                  >
                    Keep
                  </Button>
                )}
                {(g.may_revoke || g.may_give_up) && (
                  <Button
                    kind="quiet"
                    danger
                    disabled={busy}
                    ariaLabel={
                      g.may_revoke
                        ? `Revoke ${g.caregiver_name}`
                        : `Stop seeing ${g.person_name}’s medical papers`
                    }
                    onClick={() => setEnding(g)}
                  >
                    {g.may_revoke ? 'Revoke' : 'Stop seeing them'}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {grants.may_add &&
        (grants.candidates.length === 0 ? (
          <p className="muted">
            Nobody else can be named yet: a caregiver signs in as an owner or an adult.
          </p>
        ) : (
          <form className="stack" onSubmit={(e) => void add(e)} noValidate>
            <Select
              id="caregiver-who"
              label={
                mine
                  ? 'Let someone see my medical papers'
                  : `Let someone see ${props.name}’s medical papers`
              }
              value={chosen}
              options={[
                { value: '', label: 'Choose someone' },
                ...grants.candidates.map((c) => ({ value: c.member_id, label: c.display_name })),
              ]}
              onChange={setChosen}
            />
            <div className="row">
              <Button kind="primary" type="submit" disabled={busy}>
                Let them see
              </Button>
            </div>
          </form>
        ))}
      <ErrorNote message={problem} />
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {readsLooks && (
        <section aria-labelledby="caregiver-looks-h" className="stack">
          <h3 id="caregiver-looks-h" className="section-h">
            Who looked
          </h3>
          {looks.length === 0 ? (
            <p className="muted">
              {mine
                ? 'Nobody has looked at your papers as a caregiver.'
                : `Nobody has looked at ${props.name}’s papers as a caregiver.`}
            </p>
          ) : (
            <ul className="list">
              {looks.map((l, i) => (
                <li key={`${l.at}-${i}`}>
                  <span>
                    {l.document_id ? (
                      <Link to={`/documents/${l.document_id}`}>{caregiverLookWords(l)}</Link>
                    ) : (
                      caregiverLookWords(l)
                    )}
                    <span className="muted">{dateTimeWords(l.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {ending && (
        <ConfirmDialog
          title={endWords(ending).title}
          confirmLabel={endWords(ending).confirm}
          busyLabel="Stopping…"
          danger
          busy={busy}
          onConfirm={() => {
            const g = ending;
            void run(
              (t) => api.revokeCaregiver(t, g.person_member_id, g.caregiver_member_id),
              endWords(g).after,
            ).then(() => setEnding(null));
          }}
          onCancel={() => setEnding(null)}
        >
          <p>{endWords(ending).body}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * Settings → Caregivers: the caller's own — who may see their medical
 * papers, and whose papers they may see as a caregiver.
 */
export function CaregiversScreen() {
  const { authVersion, withToken } = useApp();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [members, mine] = await Promise.all([api.members(t), api.myCaregivers(t)]);
      return { me: members.items.find((m) => m.is_me) ?? null, mine };
    },
    [authVersion],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ending, setEnding] = useState<CaregiverGrantView | null>(null);
  return (
    <SettingsPage title="Caregivers" subtitle="Who can see your medical papers">
      {error && !data && (
        <LoadFailed message={error} what="your caregivers" onRetry={() => void reload()} />
      )}
      {data?.me && <CaregiversCard member={data.me} name="you" />}
      {data && data.mine.for_others.length > 0 && (
        <section aria-labelledby="care-for-h" className="stack">
          <h2 id="care-for-h" className="section-h">
            Papers you can see as a caregiver
          </h2>
          <ul className="list">
            {data.mine.for_others.map((g) => (
              <li key={g.id}>
                <span>
                  <strong>{g.person_name}</strong>
                  <span className="muted">
                    {g.confirmed
                      ? `Their medical papers, Only me ones included. You can read them, not change or share them.`
                      : `The medical papers the family sees, until ${g.person_name} keeps you.`}
                  </span>
                </span>
                <Button
                  kind="quiet"
                  danger
                  disabled={busy}
                  ariaLabel={`Stop seeing ${g.person_name}’s medical papers`}
                  onClick={() => setEnding(g)}
                >
                  Stop seeing them
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ErrorNote message={problem} />
      {ending && (
        <ConfirmDialog
          title={`Stop seeing ${ending.person_name}’s medical papers?`}
          confirmLabel="Stop seeing them"
          busyLabel="Stopping…"
          danger
          busy={busy}
          onConfirm={() => {
            const g = ending;
            setBusy(true);
            setProblem(null);
            void withToken((t) => api.revokeCaregiver(t, g.person_member_id, g.caregiver_member_id))
              .then(() => reload())
              .catch((err: unknown) => setProblem(describeError(err)))
              .finally(() => {
                setBusy(false);
                setEnding(null);
              });
          }}
          onCancel={() => setEnding(null)}
        >
          <p>
            You won’t see {ending.person_name}’s Only me medical papers any more.{' '}
            {ending.person_name} can name you again.
          </p>
        </ConfirmDialog>
      )}
    </SettingsPage>
  );
}

/**
 * Turning 18 on Home: the person's own question, asked once — keep their
 * medical papers visible to the family, or make them Only me — and an
 * owner's card to ask somebody without a sign-in in person, who may only
 * keep them as they are (or name a caregiver on their page).
 */
export function GrownUpQuestions() {
  const { authVersion, caps } = useApp();
  const offered = caps?.features.caregivers === true;
  // Home is never lost to it: refused or failed, there are none to ask.
  const { data, reload } = useLoad(
    async (t) =>
      offered
        ? (await api.grownUpQuestions(t).catch(() => ({ items: [] as GrownUpQuestionView[] })))
            .items
        : [],
    [authVersion, offered],
  );
  return <GrownUpCards items={data ?? []} onAnswered={() => void reload()} />;
}

/** The turning-18 cards themselves, for the questions given. */
export function GrownUpCards(props: { items: GrownUpQuestionView[]; onAnswered: () => void }) {
  const { withToken } = useApp();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState<GrownUpQuestionView | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  if (props.items.length === 0 && !said) return null;
  const answer = async (q: GrownUpQuestionView, choice: 'keep' | 'only_me') => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await withToken((t) => api.answerGrownUp(t, q.member_id, choice));
      if (r) {
        setSaid(
          choice === 'only_me'
            ? `Done. ${r.made_private === 1 ? 'Your medical paper is' : `Your ${r.made_private} medical papers are`} Only me now.`
            : q.asks === 'self'
              ? 'Your medical papers stay visible to the family.'
              : `${q.display_name}’s medical papers stay visible to the family.`,
        );
        props.onAnswered();
      }
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };
  return (
    <section aria-labelledby="grown-up-h" className="stack grown-up">
      <h2 id="grown-up-h" className="section-h">
        Medical papers
      </h2>
      {props.items.map((q) => (
        <div key={q.member_id} className="card stack">
          {q.asks === 'role_first' ? (
            <>
              <p>
                <strong>{q.title}</strong>
              </p>
              <p className="muted">{q.label}</p>
              <div className="row">
                <Link to={`/people/${q.member_id}`} className="btn btn-quiet">
                  Open {q.display_name}’s page
                </Link>
              </div>
            </>
          ) : q.asks === 'self' ? (
            <>
              <p>
                <strong>{q.title}</strong>
              </p>
              <p className="muted">{q.label}</p>
              <div className="row">
                <Button kind="primary" disabled={busy} onClick={() => void answer(q, 'keep')}>
                  Keep them visible
                </Button>
                <Button kind="quiet" disabled={busy} onClick={() => setAsking(q)}>
                  Make them Only me
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>
                <strong>{q.title}</strong>
              </p>
              <p className="muted">{q.label}</p>
              <div className="row">
                <Button kind="primary" disabled={busy} onClick={() => void answer(q, 'keep')}>
                  They want them kept as they are
                </Button>
                <Link to={`/people/${q.member_id}`} className="btn btn-quiet">
                  Name a caregiver
                </Link>
              </div>
            </>
          )}
        </div>
      ))}
      <ErrorNote message={problem} />
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {asking && (
        <ConfirmDialog
          title="Make your medical papers Only me?"
          confirmLabel="Make them Only me"
          busyLabel="Making them Only me…"
          danger
          busy={busy}
          onConfirm={() => void answer(asking, 'only_me')}
          onCancel={() => setAsking(null)}
        >
          <p>
            {asking.papers === 1
              ? 'Your medical paper becomes Only me.'
              : `Your ${asking.papers} medical papers become Only me.`}{' '}
            Nobody else in the family can open them after this, owners included — only a caregiver
            you name. Links you made to them end. You can’t answer this question again, but you can
            change each paper yourself later.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
