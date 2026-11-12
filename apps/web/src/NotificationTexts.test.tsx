import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SMS_CLOUD_URL, type SmsSettingsView } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Notifications by text (0.9.0, SMS2), on the web: Settings →
 * Notifications offers the day's reminders, the security alerts and a link
 * opened by text, and quiet hours — once the household's texts are set up
 * and the person's own number is confirmed; until then, where to add it.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
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

const WORKING: SmsSettingsView = {
  settings: null,
  ready: true,
  sent_this_month: 3,
  monthly_cap: 200,
  cloud_url: SMS_CLOUD_URL,
};

function at(over: Partial<FakeState>, role: 'owner' | 'adult' = 'owner') {
  const state = fresh({ members: [{ ...ME, role }, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/settings/notifications');
  render(<App />);
  return state;
}

const confirmed = { me: { masked: '•••• •••123', confirmed: true, code: '123456' } };

describe('Settings → Notifications, by text (SMS2)', () => {
  it('offers each by text, off until turned on, and the quiet hours, saved as changed', async () => {
    const state = at({
      sms: { view: structuredClone(WORKING), phones: structuredClone(confirmed) },
    });
    const group = await screen.findByRole('group', { name: 'By text' });
    expect(within(group).getByText(/To your number, •••• •••123/)).toBeVisible();
    const daily = within(group).getByLabelText(/The day's reminders, by text/);
    const alerts = within(group).getByLabelText(/Security alerts, by text/);
    const opened = within(group).getByLabelText(/A link I shared is opened, by text/);
    for (const box of [daily, alerts, opened]) expect(box).not.toBeChecked();
    expect(within(group).getByLabelText('Quiet hours from')).toHaveValue('21:00');
    expect(within(group).getByLabelText('Until')).toHaveValue('08:00');

    fireEvent.click(daily);
    await waitFor(() => expect(daily).toBeChecked());
    fireEvent.click(alerts);
    await waitFor(() => expect(alerts).toBeChecked());
    fireEvent.change(within(group).getByLabelText('Quiet hours from'), {
      target: { value: '22:30' },
    });
    await waitFor(() => expect(state.preferenceSaves).toHaveLength(3));
    expect(state.preferenceSaves).toEqual([
      { daily_text: true },
      { alerts_text: true },
      { quiet_from: '22:30' },
    ]);
    expect(state.preferences).toMatchObject({
      daily_text: true,
      alerts_text: true,
      share_opened_text: false,
      quiet_from: '22:30',
      quiet_to: '08:00',
    });
    await expectAccessible();
  });

  it('a number not confirmed yet: where to add it, and nothing to turn on', async () => {
    at({
      sms: {
        view: structuredClone(WORKING),
        phones: { me: { masked: '•••• •••123', confirmed: false, code: '123456' } },
      },
    });
    const line = await screen.findByTestId('texts-need-number');
    expect(line).toHaveTextContent(
      'Add and confirm your mobile number on your profile to get texts.',
    );
    expect(within(line).getByRole('link', { name: 'your profile' })).toHaveAttribute(
      'href',
      '/people/me',
    );
    expect(screen.queryByRole('group', { name: 'By text' })).toBeNull();
  });

  it('texts not set up: an owner is told where; anybody else sees nothing of them', async () => {
    at({ sms: { view: { ...structuredClone(WORKING), ready: false } } });
    expect(await screen.findByRole('link', { name: 'Text messages' })).toHaveAttribute(
      'href',
      '/settings/texts',
    );
    expect(screen.queryByRole('group', { name: 'By text' })).toBeNull();
    cleanup();
    at({ sms: { view: { ...structuredClone(WORKING), ready: false } } }, 'adult');
    await screen.findByLabelText('A summary every Sunday evening, by email');
    expect(screen.queryByRole('link', { name: 'Text messages' })).toBeNull();
    expect(screen.queryByTestId('texts-need-number')).toBeNull();
  });

  it('an older vault, without notifications by text: nothing of them', async () => {
    at({
      sms: { view: structuredClone(WORKING), phones: structuredClone(confirmed) },
      smsNotifications: false,
    });
    await screen.findByLabelText('A summary every Sunday evening, by email');
    expect(screen.queryByRole('group', { name: 'By text' })).toBeNull();
    expect(screen.queryByTestId('texts-need-number')).toBeNull();
  });
});
