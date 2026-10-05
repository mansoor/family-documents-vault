import { initialsFor } from '@fdv/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, type Member } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { answersBody, answersFrom, HouseholdAnswerFields } from '../household-answers.js';
import { Avatar, Button, ErrorNote, Field, Logo } from '../ui.js';

/**
 * First run, four boards: account → a few quick questions → who is in
 * the family → your starting list. The wizard fills the household profile
 * (decision 6) so missing-document suggestions work from day one, and it
 * means nobody faces an empty vault.
 */

type Step = 'account' | 'profile' | 'household' | 'ready';

const Steps = ({ current }: { current: Step }) => {
  const order: Step[] = ['profile', 'household', 'ready'];
  return (
    <div className="steps" aria-hidden="true">
      {order.map((s) => (
        <span
          key={s}
          className={`step${order.indexOf(s) <= order.indexOf(current) ? ' step-on' : ''}`}
        />
      ))}
    </div>
  );
};

export function SetupScreen() {
  const { caps, session, reloadCaps, markAuthChanged, withToken } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(
    caps?.setup_required === false && session.signedIn ? 'profile' : 'account',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- account
  const [household, setHousehold] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const createAccount = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      session.accept(
        await api.setup({ household_name: household, display_name: name, email, password }),
      );
      markAuthChanged();
      await reloadCaps();
      setStep('profile');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // --- profile
  const [answers, setAnswers] = useState(() => answersFrom(null));
  const { home, vehicles } = answers;

  const saveProfile = async () => {
    setBusy(true);
    setError(null);
    try {
      await withToken((t) => api.updateProfile(t, answersBody(answers)));
      setStep('household');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // --- household
  const [members, setMembers] = useState<Member[] | null>(null);
  const [newName, setNewName] = useState('');
  const [newDob, setNewDob] = useState('');
  const loadMembers = async () => {
    const r = await withToken((t) => api.members(t));
    if (r) setMembers(r.items);
  };
  if (step === 'household' && members === null) void loadMembers();
  const addMember = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await withToken((t) =>
        api.addMember(t, { display_name: newName.trim(), date_of_birth: newDob || null }),
      );
      setNewName('');
      setNewDob('');
      await loadMembers();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'account') {
    return (
      <main className="page">
        <Logo />
        <div>
          <h1 style={{ fontSize: 32 }}>Set up your family's vault</h1>
          <p className="lede">
            You are the first person here, so you become the owner. You can invite the others
            afterwards.
          </p>
        </div>
        <form onSubmit={(e) => void createAccount(e)} className="card stack">
          <Field
            id="household"
            label="What should we call your family?"
            value={household}
            onChange={setHousehold}
            hint="For example: The Seikh family"
          />
          <Field id="name" label="Your name" value={name} onChange={setName} autoComplete="name" />
          <Field
            id="email"
            label="Your email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
          <Field
            id="password"
            label="Choose a password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint="At least 10 characters. A few words you will remember work best."
          />
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Setting up…' : 'Create my vault'}
          </Button>
        </form>
      </main>
    );
  }

  if (step === 'profile') {
    return (
      <main className="page page-top">
        <div className="topbar">
          <span style={{ flexGrow: 1 }} />
          <Steps current="profile" />
          <span style={{ flexGrow: 1 }} />
          <Button kind="link" onClick={() => setStep('household')}>
            Skip
          </Button>
        </div>
        <div>
          <h1 style={{ fontSize: 28 }}>A few quick questions</h1>
          <p className="lede">
            So we can tell you which documents a family like yours usually keeps. Nothing here
            leaves your vault.
          </p>
        </div>
        <div className="stack">
          <HouseholdAnswerFields value={answers} onChange={setAnswers} />
          <ErrorNote message={error} />
          <Button onClick={() => void saveProfile()} disabled={busy}>
            Next
          </Button>
        </div>
      </main>
    );
  }

  if (step === 'household') {
    return (
      <main className="page page-top">
        <div className="topbar">
          <span style={{ flexGrow: 1 }} />
          <Steps current="household" />
          <span style={{ flexGrow: 1 }} />
          <Button kind="link" onClick={() => setStep('ready')}>
            Skip
          </Button>
        </div>
        <div>
          <h1 style={{ fontSize: 28 }}>Who is in the family?</h1>
          <p className="lede">
            Add everyone whose documents you keep. They do not need their own sign-in, and you can
            invite them later.
          </p>
        </div>
        <ul className="list" aria-label="Family members">
          {(members ?? []).map((m) => (
            <li key={m.id} className="person">
              <Avatar
                name={m.display_name}
                colour={m.colour}
                size={44}
                initials={initialsFor(members ?? []).get(m.id)}
              />
              <span>
                <strong>{m.display_name}</strong>
                <span className="muted">
                  {m.is_me
                    ? 'You · owner of this vault'
                    : m.has_account
                      ? 'Adult'
                      : 'No sign-in yet'}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => void addMember(e)} className="stack">
          <div className="row">
            <div className="field" style={{ flexGrow: 1 }}>
              <label htmlFor="new-name">Name of another family member</label>
              <input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Add another name"
              />
            </div>
            <Button type="submit" kind="quiet" disabled={busy}>
              Add
            </Button>
          </div>
          <div className="field">
            <label htmlFor="new-dob">Date of birth</label>
            <input
              id="new-dob"
              type="date"
              value={newDob}
              onChange={(e) => setNewDob(e.target.value)}
            />
            <span className="muted">
              Optional, and only for the children: it is how we know whose birth certificate to ask
              about.
            </span>
          </div>
        </form>
        <p className="muted">
          Each adult keeps their own private documents. Nobody else can open those, including you.
        </p>
        <ErrorNote message={error} />
        <Button onClick={() => setStep('ready')}>Next</Button>
      </main>
    );
  }

  return (
    <main className="page page-top">
      <div className="topbar">
        <span style={{ flexGrow: 1 }} />
        <Steps current="ready" />
        <span style={{ flexGrow: 1 }} />
      </div>
      <div>
        <h1 style={{ fontSize: 28 }}>Your starting list</h1>
        <p className="lede">
          Families like yours usually keep these. Add them whenever you like — the list waits for
          you.
        </p>
      </div>
      <ul className="list">
        {[
          ['Passports', 'For everyone who travels'],
          ['Birth certificates', 'Especially for children'],
          home === 'own'
            ? ['Home insurance and deed', 'Because you own your home']
            : ['Lease and renter insurance', 'Because you rent'],
          vehicles && vehicles !== '0'
            ? [
                'Vehicle titles and registration',
                `For your ${vehicles === '3' ? 'three or more' : vehicles} vehicle${vehicles === '1' ? '' : 's'}`,
              ]
            : null,
          ["Last year's tax return", 'Plus any forms you still have'],
        ]
          .filter((x): x is [string, string] => x !== null)
          .map(([title, why]) => (
            <li key={title}>
              <span>
                <strong>{title}</strong>
                <span className="muted">{why}</span>
              </span>
              <Button kind="quiet" onClick={() => void navigate('/add')}>
                Add
              </Button>
            </li>
          ))}
      </ul>
      <div className="stack">
        <Button onClick={() => void navigate('/add')}>Add my first document</Button>
        <Button kind="link" onClick={() => void navigate('/')}>
          Look around first
        </Button>
      </div>
    </main>
  );
}
