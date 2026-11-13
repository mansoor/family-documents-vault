import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { holdAccountLinkToken } from './link-token.js';
import { fresh, installFakeApi, signedIn } from './test-api.js';

/**
 * Neutral wording in notifications and email (0.9.0, H2): the household's
 * choice in Settings → Privacy, an owner's — each with the lines it would
 * send — and each person's own in Settings → Notifications, beside the household's,
 * than the household's.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  holdAccountLinkToken();
});
afterEach(cleanup);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const card = async () =>
  (
    await screen.findByRole('heading', { name: 'Neutral wording in notifications and email' })
  ).closest('section') as HTMLElement;

describe('Settings → Privacy: neutral wording, the household’s', () => {
  it('an owner sees the four choices, each with its lines, Sensitive documents only chosen', async () => {
    installFakeApi(fresh({ wording: { household: 'sensitive', mine: 'household' } }));
    signedIn();
    window.history.replaceState({}, '', '/settings/privacy');
    render(<App />);
    const c = await card();
    const sensitive = await within(c).findByRole('radio', { name: /^Sensitive documents only/ });
    expect(sensitive).toBeChecked();
    const health = within(c).getByRole('radio', { name: /^Health documents only/ });
    expect(health).not.toBeChecked();
    expect(within(c).getByRole('radio', { name: /^All documents/ })).not.toBeChecked();
    expect(within(c).getByRole('radio', { name: /^Off/ })).not.toBeChecked();
    // In Settings' order: Off, Health, Sensitive, All.
    expect(
      within(c)
        .getAllByRole('radio')
        .map((r) => r.id),
    ).toEqual(['wording-off', 'wording-health', 'wording-sensitive', 'wording-all']);
    // Each choice says, in plain words, what an email would show.
    expect(sensitive).toHaveAccessibleDescription(
      /A passport \(Sensitive\): A reminder about a document — Due in 7 days.*Blood test results \(Health, not marked Sensitive\): Blood test results — Review: 20 Nov, in 7 days.*Car insurance \(neither\): Car insurance — Expires: 20 Nov, in 7 days/,
    );
    expect(health).toHaveAccessibleDescription(
      /A passport \(Sensitive\): Sara’s passport — Expires: 20 Nov, in 7 days.*Blood test results \(Health, not marked Sensitive\): A reminder about a document — Due in 7 days/,
    );
    expect(within(c).getByRole('radio', { name: /^Off/ })).toHaveAccessibleDescription(
      /Sara’s passport — Expires: 20 Nov, in 7 days/,
    );
    expect(c).toHaveTextContent('One of your private documents — Due in 7 days');
    await expectAccessible();
  });

  it('to All saves at once; Sensitive to Health names some, and asks the owner to confirm it’s them', async () => {
    const state = fresh({ wording: { household: 'sensitive', mine: 'household' } });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/privacy');
    render(<App />);
    const c = await card();
    state.stepUpNeeded = true;
    fireEvent.click(await within(c).findByRole('radio', { name: /^All documents/ }));
    await within(c).findByText('Saved: All documents.');
    expect(state.wording?.household).toBe('all');
    // Back from All, and across from Sensitive to Health, each names some:
    // asked first.
    state.wording = { household: 'sensitive', mine: 'household' };
    fireEvent.click(within(c).getByRole('radio', { name: /^Health documents only/ }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to let notifications and email name more documents/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await within(c).findByText('Saved: Health documents only.');
    expect(state.wording?.household).toBe('health');
    expect(within(c).getByRole('radio', { name: /^Health documents only/ })).toBeChecked();
  });

  it.each(['adult', 'teen', 'viewer'] as const)(
    'a %s is not shown the household’s choice',
    async (role) => {
      const state = fresh({ wording: { household: 'sensitive', mine: 'household' } });
      installFakeApi(state);
      signedIn(role);
      window.history.replaceState({}, '', role === 'adult' ? '/settings/privacy' : '/settings');
      render(<App />);
      await screen.findByRole('heading', { level: 1 });
      expect(
        screen.queryByRole('heading', { name: 'Neutral wording in notifications and email' }),
      ).toBeNull();
      expect(state.calls.some((x) => x.url === '/api/v1/household/neutral-wording')).toBe(false);
    },
  );

  it('an older vault, which does not say it, shows nothing of it', async () => {
    const state = fresh({});
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Only me documents and links outside the family' });
    expect(
      screen.queryByRole('heading', { name: 'Neutral wording in notifications and email' }),
    ).toBeNull();
  });
});

describe('Settings → Notifications: naming documents, each person’s own', () => {
  it('as the household says until chosen; every choice offered, the household’s always applying as well', async () => {
    const state = fresh({ wording: { household: 'all', mine: 'household' } });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/notifications');
    render(<App />);
    const group = await screen.findByRole('group', { name: 'Naming documents' });
    const own = await within(group).findByRole('radio', {
      name: /^As the household says \(All documents\)/,
    });
    expect(own).toBeChecked();
    // Nothing greyed out: the household's choice applies whatever they pick.
    for (const r of within(group).getAllByRole('radio')) expect(r).toBeEnabled();
    expect(group).toHaveTextContent(
      'household’s choice leaves unnamed: that always applies as well',
    );
    expect(group).toHaveTextContent('Not named in what is sent to you: All documents.');
    expect(state.calls.some((x) => x.url === '/api/v1/household/neutral-wording')).toBe(false);
    await expectAccessible();
  });

  it('a choice beside the household’s is saved, and the lines sent to them say so', async () => {
    const state = fresh({ wording: { household: 'sensitive', mine: 'household' } });
    installFakeApi(state);
    signedIn('teen');
    window.history.replaceState({}, '', '/settings/notifications');
    render(<App />);
    const group = await screen.findByRole('group', { name: 'Naming documents' });
    await waitFor(() =>
      expect(group).toHaveTextContent(
        'Not named in what is sent to you: Sensitive documents only.',
      ),
    );
    fireEvent.click(await within(group).findByRole('radio', { name: /^Health documents only/ }));
    await waitFor(() =>
      expect(group).toHaveTextContent(
        'Not named in what is sent to you: Health and Sensitive documents.',
      ),
    );
    expect(group).toHaveTextContent(
      'Blood test results (Health, not marked Sensitive): A reminder about a document — Due in 7 days',
    );
    expect(group).toHaveTextContent('Car insurance (neither): Car insurance — Expires');
    expect(state.wording?.saves).toEqual([{ to: 'mine', body: { neutral_wording: 'health' } }]);
  });

  it('a choice that names more to them asks them to confirm it’s them first', async () => {
    const state = fresh({ wording: { household: 'off', mine: 'all' }, stepUpNeeded: true });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/notifications');
    render(<App />);
    const group = await screen.findByRole('group', { name: 'Naming documents' });
    fireEvent.click(await within(group).findByRole('radio', { name: /^Health documents only/ }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(group).toHaveTextContent('Not named in what is sent to you: Health documents only.'),
    );
    expect(state.wording?.mine).toBe('health');
  });
});
