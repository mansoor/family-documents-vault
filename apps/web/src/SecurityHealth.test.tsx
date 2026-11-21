import { cleanup, render, screen, within } from '@testing-library/react';
import {
  securityHealthLines,
  type Capabilities,
  type Role,
  type SecurityHealthView,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { settingsGroups } from './settings-sections.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Settings → Server and reading → Security & health (0.9.0-dev.78), an
 * owner's: each check fine, a gentle note (a restore drill to run), or a
 * problem in plain words with where to fix it.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

const DAY_AGO = new Date(Date.now() - 20 * 3600_000).toISOString();

const FINE: SecurityHealthView = {
  hosted: false,
  backup: { state: 'fine', last_at: DAY_AGO },
  offsite: { state: 'fine', last_at: DAY_AGO, problem: null },
  restore_drill: { state: 'fine', last_at: DAY_AGO },
  audit_chain: { state: 'fine', last_at: DAY_AGO },
  failed_sign_ins: { state: 'fine', count: 0 },
  token_reuse: { state: 'fine', count: 0 },
};

function at(path: string, over: Partial<FakeState>, role: Role = 'owner') {
  const state = fresh({ members: [{ ...ME, role }, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('Settings → Security & health', () => {
  it('is an owner’s section, on a vault that offers it', async () => {
    const caps = { features: { security_health: true } } as unknown as Capabilities;
    const server = (role: Role, c: Capabilities | null = caps) =>
      settingsGroups(role, c, role === 'owner')
        .find((g) => g.key === 'server')
        ?.sections.map((s) => [s.label, s.to]);
    expect(server('owner')).toContainEqual(['Security & health', '/settings/health']);
    expect(server('owner', null)).not.toContainEqual(['Security & health', '/settings/health']);
    expect(server('adult')).toBeUndefined();
    at('/settings/health', { health: FINE }, 'adult');
    expect(
      await screen.findByText('Only an owner can see the vault’s security and health.'),
    ).toBeVisible();
  });

  it('all fine: says so, calmly, line by line', async () => {
    at('/settings/health', { health: FINE });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Security & health' }),
    ).toBeVisible();
    expect(await screen.findByTestId('health-summary')).toHaveTextContent('All fine.');
    const list = screen.getByRole('list', { name: 'Security and health' });
    const labels = within(list)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.doc-title')?.textContent);
    expect(labels).toEqual([
      'Backups',
      'Copy off-site',
      'Restore drill',
      'Activity log check',
      'Failed sign-ins',
      'Sign-ins used twice',
    ]);
    expect(within(list).getAllByText('Fine')).toHaveLength(6);
    expect(screen.getByTestId('health-failed_sign_ins')).toHaveTextContent('None in the last day.');
    const results = await axe.run(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('a problem is said in plain words, with where to fix it', async () => {
    at('/settings/health', {
      health: {
        ...FINE,
        backup: { state: 'late', last_at: '2026-11-10T12:00:00.000Z' },
        offsite: { state: 'failed', last_at: null, problem: 'credentials_rejected' },
        restore_drill: { state: 'never', last_at: null },
        audit_chain: { state: 'broken', last_at: DAY_AGO },
        failed_sign_ins: { state: 'many', count: 7 },
        token_reuse: { state: 'seen', count: 1 },
      },
    });
    expect(await screen.findByTestId('health-summary')).toHaveTextContent(
      '5 things need looking at.',
    );
    const backup = screen.getByTestId('health-backup');
    expect(backup).toHaveTextContent('No backup has been made since 10 Nov');
    expect(backup).toHaveTextContent('docker compose ps');
    const offsite = screen.getByTestId('health-offsite');
    expect(offsite).toHaveTextContent('The access key ID or secret key was not accepted.');
    expect(within(offsite).getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      '/settings/backups',
    );
    // A drill not yet run is a note, not a problem: not counted, not red.
    const drill = screen.getByTestId('health-restore_drill');
    expect(drill).toHaveTextContent('No restore drill yet.');
    expect(within(drill).getByText('When you can')).not.toHaveClass('badge-danger');
    expect(screen.getByTestId('health-audit_chain')).toHaveTextContent(
      'found a line of the activity log changed or missing',
    );
    const signIns = screen.getByTestId('health-failed_sign_ins');
    expect(signIns).toHaveTextContent('7 failed sign-ins in the last day.');
    expect(within(signIns).getByRole('link', { name: 'Open Activity' })).toHaveAttribute(
      'href',
      '/activity',
    );
    expect(screen.getByTestId('health-token_reuse')).toHaveTextContent(
      'A sign-in was used from two places in the last day, so the vault signed it out.',
    );
  });
});

describe('securityHealthLines', () => {
  const when = (iso: string) => iso.slice(0, 10);

  it('leaves out what this vault does not keep: the hosted edition’s backups, a copy not set up', () => {
    const keys = securityHealthLines(
      { ...FINE, backup: null, offsite: null, restore_drill: null },
      when,
    ).map((l) => l.key);
    expect(keys).toEqual(['audit_chain', 'failed_sign_ins', 'token_reuse']);
  });

  it('a few failed sign-ins are fine; a new vault waits calmly for its first backup and check', () => {
    const lines = securityHealthLines(
      {
        ...FINE,
        backup: { state: 'not_yet', last_at: null },
        audit_chain: { state: 'not_yet', last_at: null },
        failed_sign_ins: { state: 'fine', count: 2 },
      },
      when,
    );
    expect(lines.every((l) => l.tone === 'fine')).toBe(true);
    expect(lines.find((l) => l.key === 'backup')?.words).toBe('The first backup is made tonight.');
    expect(lines.find((l) => l.key === 'failed_sign_ins')?.words).toBe(
      '2 failed sign-ins in the last day: a mistyped password, most likely.',
    );
  });

  it('a backup that failed, a drill due, a check late: each with its fix', () => {
    const lines = securityHealthLines(
      {
        ...FINE,
        backup: { state: 'failed', last_at: '2026-11-18T02:00:00.000Z' },
        restore_drill: { state: 'due', last_at: '2026-09-01T10:00:00.000Z' },
        audit_chain: { state: 'late', last_at: '2026-11-15T03:15:00.000Z' },
        token_reuse: { state: 'seen', count: 3 },
      },
      when,
    );
    const by = (k: string) => lines.find((l) => l.key === k);
    expect(by('backup')).toMatchObject({
      tone: 'problem',
      words: 'The last backup didn’t finish. The one before was made on 2026-11-18.',
    });
    expect(by('backup')?.fix).toContain('docker compose logs worker');
    expect(by('restore_drill')?.words).toBe(
      'The last drill was on 2026-09-01. Worth running one each month.',
    );
    expect(by('restore_drill')?.fix).toContain('scripts/restore-drill.sh');
    expect(by('audit_chain')?.words).toBe('Not checked since 2026-11-15.');
    expect(by('token_reuse')?.words).toBe(
      '3 sign-ins were used from two places in the last day, so the vault signed them out.',
    );
  });
});
