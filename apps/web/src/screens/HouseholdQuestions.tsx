import { can, type Profile } from '@fdv/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { answersBody, answersFrom, HouseholdAnswerFields } from '../household-answers.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ErrorNote, TopBar } from '../ui.js';

/**
 * The household's few questions on their own (the 5.35 review, W535-10):
 * what Reminders' "We noticed something missing" asks a household that
 * never answered them, with whatever it has answered already, and back to
 * Reminders once saved. Not the first-run wizard, which goes on to who is
 * in the family and the starting list, and says things only true of a new
 * vault's first owner.
 */
export function HouseholdQuestionsScreen() {
  const { authVersion } = useApp();
  const mayAnswer = can(storedRole(), 'profile.edit');
  const { data, error } = useLoad(
    async (t) => (mayAnswer ? api.profile(t) : null),
    [authVersion, mayAnswer],
  );
  return (
    <main className="page page-top has-nav">
      <TopBar title="A few quick questions" back="/reminders" />
      <p className="lede">
        So we can tell you which documents a family like yours usually keeps. Nothing here leaves
        your vault.
      </p>
      {!mayAnswer ? (
        <p className="muted">
          An adult in the family answers these. <Link to="/reminders">Back to Reminders</Link>
        </p>
      ) : (
        <>
          <ErrorNote message={error} />
          {data && <Questions profile={data} />}
        </>
      )}
      <BottomNav />
    </main>
  );
}

function Questions({ profile }: { profile: Profile }) {
  const { withToken } = useApp();
  const navigate = useNavigate();
  const [answers, setAnswers] = useState(() => answersFrom(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) => api.updateProfile(t, answersBody(answers)));
      if (saved) void navigate('/reminders', { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <HouseholdAnswerFields value={answers} onChange={setAnswers} keptOnly />
      <ErrorNote message={error} />
      <Button onClick={() => void save()} disabled={busy}>
        {busy ? 'Saving…' : 'Save the answers'}
      </Button>
    </div>
  );
}
