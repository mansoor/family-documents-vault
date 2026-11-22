import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoLockMinutes } from '@fdv/shared';
import { App } from './App.js';
import { LOCK_SOON_WORDS, useAwayTimer } from './auto-lock.js';
import { fresh, installFakeApi, ME, signedIn } from './test-api.js';

/**
 * Lock by itself after a while away (0.9.0-dev.87), the page's half: real
 * use in any tab of the browser keeps it open; a minute before the time is
 * up it says so; as the time runs out it locks, asking the vault nothing
 * first; and while somebody uses it, the vault is told they are still here
 * at most about once a minute across the tabs.
 */

const MEMBER = 'm1';

function Timer(props: {
  minutes: AutoLockMinutes | null;
  onLock: () => void;
  onStillHere: () => void;
  holding?: boolean;
}) {
  const { lockSoon } = useAwayTimer({ member: MEMBER, ...props });
  return <p data-testid="soon">{lockSoon ? 'soon' : 'not yet'}</p>;
}

const minutes = (n: number) => n * 60_000;
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};
/** Another tab of this browser was used at `at`: its note, and the event every other tab hears. */
const otherTabUsed = (at: number) => {
  localStorage.setItem(`fdv.active.${MEMBER}`, String(at));
  window.dispatchEvent(
    new StorageEvent('storage', { key: `fdv.active.${MEMBER}`, newValue: String(at) }),
  );
};

describe('the page’s timers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says so a minute before, and locks once as the time runs out, with no input', async () => {
    const onLock = vi.fn();
    render(<Timer minutes={5} onLock={onLock} onStillHere={vi.fn()} />);
    await advance(minutes(3.9));
    expect(screen.getByTestId('soon')).toHaveTextContent('not yet');
    await advance(minutes(0.2));
    expect(screen.getByTestId('soon')).toHaveTextContent('soon');
    expect(onLock).not.toHaveBeenCalled();
    await advance(minutes(1));
    expect(onLock).toHaveBeenCalledTimes(1);
    await advance(minutes(10));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('real use starts the time again, and takes the warning away', async () => {
    const onLock = vi.fn();
    render(<Timer minutes={5} onLock={onLock} onStillHere={vi.fn()} />);
    await advance(minutes(3));
    fireEvent.keyDown(window, { key: 'a' });
    await advance(minutes(4.5));
    expect(screen.getByTestId('soon')).toHaveTextContent('soon');
    fireEvent.pointerMove(window);
    expect(screen.getByTestId('soon')).toHaveTextContent('not yet');
    await advance(minutes(4.9));
    expect(onLock).not.toHaveBeenCalled();
    fireEvent.scroll(window);
    await advance(minutes(5));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('one tab in use keeps every tab open', async () => {
    const onLock = vi.fn();
    render(<Timer minutes={10} onLock={onLock} onStillHere={vi.fn()} />);
    await advance(minutes(8));
    otherTabUsed(Date.now());
    await advance(minutes(9));
    expect(onLock).not.toHaveBeenCalled();
    // Missed the event: its note is read again before it locks.
    localStorage.setItem(`fdv.active.${MEMBER}`, String(Date.now()));
    await advance(minutes(5));
    expect(onLock).not.toHaveBeenCalled();
    await advance(minutes(6));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('tells the vault somebody is still here at most once a minute, across tabs', async () => {
    const onStillHere = vi.fn();
    render(<Timer minutes={15} onLock={vi.fn()} onStillHere={onStillHere} />);
    fireEvent.pointerMove(window);
    expect(onStillHere).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) {
      await advance(2_000);
      fireEvent.pointerMove(window);
    }
    expect(onStillHere).toHaveBeenCalledTimes(1);
    await advance(30_000);
    fireEvent.keyDown(window, { key: 'b' });
    expect(onStillHere).toHaveBeenCalledTimes(2);
    // Another tab told it just now: this one does not.
    await advance(minutes(1.5));
    localStorage.setItem(`fdv.stillHere.${MEMBER}`, String(Date.now()));
    fireEvent.pointerDown(window);
    expect(onStillHere).toHaveBeenCalledTimes(2);
    // Nobody using it: nothing is said.
    await advance(minutes(10));
    expect(onStillHere).toHaveBeenCalledTimes(2);
  });

  it('a page woken past its time locks before anything counts as use', async () => {
    const onLock = vi.fn();
    render(<Timer minutes={5} onLock={onLock} onStillHere={vi.fn()} />);
    // Asleep: the clock moves on, and no timer runs.
    vi.setSystemTime(Date.now() + minutes(6));
    fireEvent.keyDown(window, { key: 'a' });
    expect(onLock).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(window);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('the tab shown again past its time locks at once', async () => {
    const onLock = vi.fn();
    render(<Timer minutes={10} onLock={onLock} onStillHere={vi.fn()} />);
    vi.setSystemTime(Date.now() + minutes(11));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('an upload sending holds it off, telling the vault, and it locks as the upload ends', async () => {
    const onLock = vi.fn();
    const onStillHere = vi.fn();
    const shown = render(<Timer minutes={5} onLock={onLock} onStillHere={onStillHere} holding />);
    await advance(minutes(20));
    expect(onLock).not.toHaveBeenCalled();
    expect(screen.getByTestId('soon')).toHaveTextContent('not yet');
    // About once a minute, while it sends.
    expect(onStillHere.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect(onStillHere.mock.calls.length).toBeLessThanOrEqual(21);
    shown.rerender(<Timer minutes={5} onLock={onLock} onStillHere={onStillHere} />);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('an upload that ends with somebody there locks nothing', async () => {
    const onLock = vi.fn();
    const shown = render(<Timer minutes={5} onLock={onLock} onStillHere={vi.fn()} holding />);
    await advance(minutes(3));
    fireEvent.keyDown(window, { key: 'z' });
    shown.rerender(<Timer minutes={5} onLock={onLock} onStillHere={vi.fn()} />);
    await advance(minutes(4));
    expect(onLock).not.toHaveBeenCalled();
    await advance(minutes(2));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('Off locks nothing, however long', async () => {
    const onLock = vi.fn();
    const onStillHere = vi.fn();
    render(<Timer minutes={null} onLock={onLock} onStillHere={onStillHere} />);
    fireEvent.pointerMove(window);
    await advance(minutes(600));
    expect(onLock).not.toHaveBeenCalled();
    expect(onStillHere).not.toHaveBeenCalled();
    expect(screen.getByTestId('soon')).toHaveTextContent('not yet');
  });
});

describe('in the app', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/documents');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('locks the page as the time runs out, and the vault is told it locked itself', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z'), shouldAdvanceTime: true });
    const state = fresh({ members: [ME], documents: [], sessionLock: true, autoLockMinutes: 5 });
    installFakeApi(state);
    signedIn('owner');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Documents' });
    // What the page asks by itself says so; nothing it asked was somebody's use.
    await waitFor(() =>
      expect(
        state.calls.some((c) => c.url === '/api/v1/me' && c.headers?.['x-fdv-background'] === '1'),
      ).toBe(true),
    );
    // Its time known: a key pressed is use, and the vault is told so.
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'k' });
      expect(state.stillHere).toBe(1);
    });
    await act(async () => {
      vi.advanceTimersByTime(minutes(4) + 1_000);
    });
    expect(await screen.findByText(LOCK_SOON_WORDS)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(minutes(1));
    });
    expect(await screen.findByRole('heading', { name: /The vault is locked/ })).toBeInTheDocument();
    await waitFor(() => expect(state.lockBodies).toEqual([{ away: true }]));
  });

  it('keeps the page open while it is used, and tells the vault somebody is still here', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z'), shouldAdvanceTime: true });
    const state = fresh({ members: [ME], documents: [], sessionLock: true, autoLockMinutes: 5 });
    installFakeApi(state);
    signedIn('owner');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Documents' });
    await waitFor(() => expect(state.calls.some((c) => c.url === '/api/v1/me')).toBe(true));
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        vi.advanceTimersByTime(minutes(1));
      });
      fireEvent.keyDown(window, { key: 'j' });
    }
    expect(screen.queryByRole('heading', { name: /The vault is locked/ })).toBeNull();
    await waitFor(() => expect(state.stillHere ?? 0).toBeGreaterThanOrEqual(4));
    expect(state.lockBodies ?? []).toEqual([]);
  });
});

describe('a time changed while the page is open', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is asked for again as another tab changes it, and the page keeps to it', async () => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/documents');
    vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z'), shouldAdvanceTime: true });
    const state = fresh({ members: [ME], documents: [], sessionLock: true, autoLockMinutes: 60 });
    installFakeApi(state);
    signedIn('owner');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Documents' });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'k' });
      expect(state.stillHere).toBe(1);
    });
    const asked = () => state.calls.filter((c) => c.url === '/api/v1/me').length;
    const before = asked();
    // Changed in Settings in another tab.
    state.autoLockMinutes = 5;
    act(() => {
      localStorage.setItem('fdv.autoLockChanged', String(Date.now()));
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'fdv.autoLockChanged', newValue: String(Date.now()) }),
      );
    });
    await waitFor(() => expect(asked()).toBeGreaterThan(before));
    await act(async () => {
      vi.advanceTimersByTime(minutes(5) + 1_000);
    });
    expect(await screen.findByRole('heading', { name: /The vault is locked/ })).toBeInTheDocument();
  });

  it('and Off: no timer, however long', async () => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/documents');
    vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z'), shouldAdvanceTime: true });
    const state = fresh({ members: [ME], documents: [], sessionLock: true, autoLockMinutes: 5 });
    installFakeApi(state);
    signedIn('owner');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Documents' });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'k' });
      expect(state.stillHere).toBe(1);
    });
    state.autoLockMinutes = null;
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'fdv.autoLockChanged', newValue: String(Date.now()) }),
      );
    });
    await waitFor(() => expect(document.querySelector('.auto-lock-soon')).toBeNull());
    await act(async () => {
      vi.advanceTimersByTime(minutes(30));
    });
    expect(screen.queryByRole('heading', { name: /The vault is locked/ })).toBeNull();
    expect(state.lockBodies ?? []).toEqual([]);
  });
});

describe('in Settings', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an owner chooses the family's time in Privacy, saved as it is chosen", async () => {
    const state = fresh({ members: [ME], documents: [], sessionLock: true, autoLockMinutes: 15 });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/settings/privacy');
    render(<App />);
    const family = await screen.findByRole('combobox', { name: 'For the family' });
    expect(family).toHaveValue('15');
    // Chosen, then saved: a choice alone sends nothing.
    fireEvent.change(family, { target: { value: '5' } });
    expect(state.calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(
      within(family.closest('section') as HTMLElement).getByRole('button', { name: 'Save' }),
    );
    expect(await screen.findByText('Saved: After 5 minutes.')).toBeInTheDocument();
    expect(localStorage.getItem('fdv.autoLockChanged')).not.toBeNull();
    expect(
      state.calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/household/auto-lock')?.body,
    ).toEqual({ minutes: 5 });
    fireEvent.change(family, { target: { value: '' } });
    fireEvent.click(
      within(family.closest('section') as HTMLElement).getByRole('button', { name: 'Save' }),
    );
    expect(await screen.findByText('Saved: Off.')).toBeInTheDocument();
  });

  it('anybody chooses a shorter time for themselves, never a longer one', async () => {
    const state = fresh({
      members: [ME],
      documents: [],
      sessionLock: true,
      autoLockMinutes: 15,
      autoLockHousehold: 15,
    });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    const mine = await screen.findByRole('combobox', { name: 'For you' });
    const offered = within(mine)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(offered).toEqual([
      'As the family’s (15 minutes)',
      'After 5 minutes',
      'After 10 minutes',
    ]);
    fireEvent.change(mine, { target: { value: '5' } });
    const card = mine.closest('section') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved: it locks after 5 minutes.')).toBeInTheDocument();
    expect(state.autoLockMine).toBe(5);
  });
});
