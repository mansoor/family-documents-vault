import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { activityCsvCappedRow, activityCsvHeader } from '@fdv/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * The activity log as a spreadsheet (0.9.0-dev.82; the owner's ask of 19
 * Nov 2026): Download CSV beside Print on the Activity page asks the vault
 * for the lines the page's filters keep — the document of its chip too —
 * and saves the file it answers; past the vault's cap, the page says only
 * the newest are in it. Without the vault's say-so, no button.
 */

let saved: string[] = [];

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  saved = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: /min-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:csv'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download || (this.getAttribute('href') ?? ''));
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

const LINES: FakeState['activity'] = [
  {
    id: 2,
    at: '2026-11-20T12:00:00Z',
    text: 'Owner downloaded “Water bill”',
    notable: false,
    document_id: 'doc-1',
    actor_member_id: null,
    kind: 'opened',
  },
  {
    id: 1,
    at: '2026-11-19T12:00:00Z',
    text: 'Owner signed in',
    notable: false,
    document_id: null,
    actor_member_id: null,
    kind: 'sign_in',
  },
];
const FILE = `${activityCsvHeader().slice(1)}row\r\n`;

function open(path: string, over: Partial<FakeState> = {}) {
  const state = fresh({ activity: LINES, activityCsv: FILE, ...over });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('Download CSV on the Activity page', () => {
  it('sits beside Print, and saves the vault’s file for the filters in the address', async () => {
    const state = open('/activity?who=else&kind=opened&from=2026-11-01&to=2026-11-20');
    const button = await screen.findByRole('button', { name: 'Download CSV' });
    expect(button.nextElementSibling).toBe(screen.getByRole('button', { name: 'Print' }));
    fireEvent.click(button);
    await waitFor(() => expect(saved).toEqual(['activity-vault-2026-11-21.csv']));
    expect(state.activityCsvAsks).toEqual(['who=else&kind=opened&from=2026-11-01&to=2026-11-20']);
    // All there: nothing more to say.
    expect(screen.queryByText(/Only the newest/)).toBeNull();
  });

  it('asks for every line with no filter, and for the chip’s document with one', async () => {
    const whole = open('/activity');
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(whole.activityCsvAsks).toEqual(['']));
    cleanup();
    const one = open('/activity?document=doc-1&kind=opened', {
      documentActivity: { 'doc-1': [LINES[0] as FakeState['activity'][number]] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(one.activityCsvAsks).toEqual(['kind=opened&document=doc-1']));
  });

  it('says so when the vault stopped at its cap, until the filters change', async () => {
    open('/activity', { activityCsv: `${FILE}${activityCsvCappedRow()}` });
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    expect(
      await screen.findByText(/Only the newest lines are in the file: it holds 50,000 at most/),
    ).toHaveAttribute('role', 'status');
    expect(saved).toEqual(['activity-vault-2026-11-21.csv']);
    // Another filter: the note was about another file.
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'sign_in' } });
    await waitFor(() => expect(screen.queryByText(/Only the newest lines/)).toBeNull());
  });

  it('asks once however often it is pressed while it is on its way', async () => {
    const state = open('/activity');
    const button = await screen.findByRole('button', { name: 'Download CSV' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(state.activityCsvAsks).toEqual(['']);
  });

  it('says what the vault refused, and saves nothing', async () => {
    open('/activity?kind=opened', {
      refuseWith: (method, path) =>
        method === 'GET' && path === '/api/v1/audit/export'
          ? {
              status: 422,
              code: 'validation_failed',
              message: 'That is not a day on the calendar.',
            }
          : undefined,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('That is not a day on the calendar.')).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it('says days the wrong way round itself, and asks nothing', async () => {
    const state = open('/activity?from=2026-11-20&to=2026-11-01');
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('From is after To: choose days in order.')).toBeInTheDocument();
    expect(state.activityCsvAsks).toBeUndefined();
    expect(saved).toEqual([]);
  });

  it('is not there on a vault that cannot', async () => {
    const state = fresh({ activity: LINES });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/activity');
    render(<App />);
    await screen.findByRole('button', { name: 'Print' });
    await screen.findByText('Owner signed in');
    await waitFor(() =>
      expect(state.calls.some((c) => c.url.includes('/capabilities'))).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
  });
});
