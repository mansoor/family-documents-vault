import { securityHealthLines, type HealthLine } from '@fdv/shared';
import { Link } from 'react-router';
import { api } from './api.js';
import { useApp, useLoad } from './app-context.js';
import { shortWhenWords } from './family-time.js';
import { SettingsPage } from './screens/Settings.js';
import { LoadFailed } from './ui.js';

/**
 * Settings → Server and reading → Security & health (0.9.0-dev.78), an
 * owner's: the last backup and its copy off-site, the last restore drill,
 * the activity log's check, and the day's failed sign-ins and sign-ins
 * used from two places — each fine, or a problem in plain words with where
 * to fix it; a restore drill not run lately is a gentle note. Read from what the vault already keeps; nothing is asked of
 * anybody to see it.
 */
export function SecurityHealthScreen() {
  const { authVersion } = useApp();
  const { data, error, reload } = useLoad((t) => api.securityHealth(t), [authVersion]);
  const lines = data ? securityHealthLines(data, (iso) => shortWhenWords(iso)) : null;
  // A note (a restore drill to run) is worth doing, and no problem.
  const problems = lines?.filter((l) => l.tone === 'problem').length ?? 0;
  return (
    <SettingsPage title="Security & health" subtitle="Backups, the activity log’s check, sign-ins">
      {lines === null && error ? (
        <LoadFailed message={error} what="security and health" onRetry={() => void reload()} />
      ) : lines === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <section className="card health-card" aria-labelledby="health-summary">
          <p
            id="health-summary"
            className={problems === 0 ? 'attention attention-calm' : 'attention'}
            role="status"
            data-testid="health-summary"
          >
            {problems === 0
              ? 'All fine.'
              : problems === 1
                ? 'One thing needs looking at.'
                : `${problems} things need looking at.`}
          </p>
          <ul className="health-lines" aria-label="Security and health">
            {lines.map((l) => (
              <HealthRow key={l.key} line={l} />
            ))}
          </ul>
        </section>
      )}
    </SettingsPage>
  );
}

function HealthRow({ line }: { line: HealthLine }) {
  return (
    <li className="health-line" data-testid={`health-${line.key}`}>
      <div className="health-line-head">
        <span className="doc-title">{line.label}</span>
        <span
          className={
            line.tone === 'fine'
              ? 'badge'
              : line.tone === 'note'
                ? 'badge badge-quiet'
                : 'badge badge-danger'
          }
        >
          {line.tone === 'fine' ? 'Fine' : line.tone === 'note' ? 'When you can' : 'Look at this'}
        </span>
      </div>
      <p className="health-words">{line.words}</p>
      {line.fix && (
        <p className="muted health-fix">
          {line.fix}
          {line.to && (
            <>
              {' '}
              <Link to={line.to}>{line.to === '/activity' ? 'Open Activity' : 'Open it'}</Link>
            </>
          )}
        </p>
      )}
    </li>
  );
}
