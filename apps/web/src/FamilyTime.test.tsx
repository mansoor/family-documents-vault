import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { formatDate, localToday, shareQuickPicks, whenExactly } from '@fdv/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  browserZone,
  dateOnlyWords,
  dayWordsOf,
  endWords,
  exactWords,
  relativeWords,
  zoneNote,
} from './family-time.js';
import { setCurrentFamilyZone } from './family-zone-store.js';
import { bornLine } from './screens/Person.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Every time the web app shows, on the family's clock (0.9.0, TZ): the
 * family's zone whatever this browser's is, the zone named only where the
 * two differ, and a date without a time never moved by any zone.
 */

let browserWas: string | undefined;
/** This browser, somewhere: as Chromium's timezoneId would put it. */
const browserIn = (zone: string) => {
  process.env.TZ = zone;
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  browserWas = process.env.TZ;
});
afterEach(() => {
  if (browserWas === undefined) delete process.env.TZ;
  else process.env.TZ = browserWas;
  vi.restoreAllMocks();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** A fact's value, whole, however its words are set in spans. */
const inDd = (re: RegExp) => (_: string, el: Element | null) =>
  el?.tagName === 'DD' && re.test((el.textContent ?? '').trim());

const open = (
  path: string,
  over: Partial<FakeState>,
  role: Parameters<typeof signedIn>[0] = 'owner',
) => {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
};

// 14:05 UTC on 25 September 2026: 15:05 in London (BST), 07:05 in Los
// Angeles (PDT), 04:05 on the 26th in Kiritimati, 03:05 on the 25th in Pago Pago.
const AT = '2026-09-25T14:05:00Z';

describe('the helpers: the family’s clock, named where the browser’s differs', () => {
  it('says a moment on the family’s zone whatever the browser’s, naming it only when the clocks differ', () => {
    browserIn('America/Los_Angeles');
    expect(browserZone()).toBe('America/Los_Angeles');
    expect(exactWords(AT, 'Europe/London')).toBe('25 Sept 2026, 3:05pm BST');
    expect(endWords(AT, 'Europe/London')).toBe('Friday 25 September at 15:05 BST');
    // A zone with no well-known short name: its offset.
    expect(exactWords(AT, 'Asia/Kolkata')).toBe('25 Sept 2026, 7:35pm GMT+5:30');
    // In the family's own zone: nothing added.
    browserIn('Europe/London');
    expect(exactWords(AT, 'Europe/London')).toBe('25 Sept 2026, 3:05pm');
    expect(zoneNote('Europe/London', AT)).toBe('');
    // A zone whose clock reads the same at that moment needs no name either.
    browserIn('Europe/Dublin');
    expect(zoneNote('Europe/London', AT)).toBe('');
    // Named always, where a page is read anywhere.
    expect(zoneNote('Europe/London', AT, true)).toBe(' BST');
    // In winter London is on UTC's clock: no name for a UTC browser then.
    browserIn('UTC');
    expect(zoneNote('Europe/London', '2026-12-25T12:00:00Z')).toBe('');
    expect(zoneNote('Europe/London', AT)).toBe(' BST');
  });

  it('says the family’s day of a moment across the date line, with no zone, as a day has no time', () => {
    browserIn('Pacific/Pago_Pago');
    expect(dayWordsOf(AT, 'Pacific/Kiritimati')).toBe('26 September');
    expect(dayWordsOf(AT, 'Pacific/Pago_Pago')).toBe('25 September');
    // "yesterday" and "today" are the family's.
    const now = new Date('2026-09-25T15:00:00Z');
    expect(relativeWords(AT, 'Pacific/Kiritimati', now)).toBe('today, 4:05am GMT+14');
    browserIn('Pacific/Kiritimati');
    expect(relativeWords(AT, 'Pacific/Kiritimati', now)).toBe('today, 4:05am');
  });

  it('a person’s age turns on their birthday on the family’s calendar, not this browser’s (the TZ review)', () => {
    // Fourteen years ago today in Kiritimati, where it is already tomorrow
    // (or later) for a browser in Pago Pago.
    const today = localToday('Pacific/Kiritimati');
    const born = `${Number(today.slice(0, 4)) - 14}${today.slice(4)}`;
    browserIn('Pacific/Pago_Pago');
    setCurrentFamilyZone('Pacific/Kiritimati');
    try {
      expect(bornLine(born, false)).toMatch(/ · 14$/);
      setCurrentFamilyZone('Pacific/Pago_Pago');
      expect(bornLine(born, false)).toMatch(/ · 13$/);
    } finally {
      setCurrentFamilyZone(null);
    }
  });

  it('never moves a date without a time: across a change of the clocks, and across the date line', () => {
    // 29 March 2026: Europe's clocks go forward. 31 December: the year's end.
    const days = ['2026-03-29', '2026-10-25', '2026-12-31', '2027-01-01'];
    const said = (zone: string) => {
      browserIn(zone);
      return days.map((d) => [
        dateOnlyWords(d),
        formatDate({ date: d, precision: 'day' }),
        bornLine(d, true),
      ]);
    };
    const kiritimati = said('Pacific/Kiritimati');
    expect(kiritimati).toEqual(said('Pacific/Pago_Pago'));
    expect(kiritimati).toEqual(said('Europe/London'));
    expect(kiritimati).toEqual(said('America/Los_Angeles'));
    expect(kiritimati.map(([words]) => words)).toEqual([
      '29 March 2026',
      '25 October 2026',
      '31 December 2026',
      '1 January 2027',
    ]);
    expect(dateOnlyWords('2031-03', { day: false, month: 'short' })).toBe('Mar 2031');
  });
});

describe('the screens: every time on the family’s clock', () => {
  it('the Activity table says when on the family’s clock, named, whatever this browser’s zone', async () => {
    browserIn('America/Los_Angeles');
    open('/activity', {
      timezone: 'Europe/London',
      timezoneSource: 'household',
      activity: [
        {
          id: 1,
          at: AT,
          text: 'Sara moved “Water bill” to the Trash',
          notable: false,
          document_id: null,
        },
      ],
    });
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('25 Sept 2026, 3:05pm BST')).toBeInTheDocument();
    // Not this browser's clock, which would say 7:05am.
    expect(within(table).queryByText(/7:05am/)).toBeNull();
    await expectAccessible();
  });

  it('in the family’s own zone, a time is said with nothing added', async () => {
    browserIn('Europe/London');
    open('/activity', {
      timezone: 'Europe/London',
      activity: [
        {
          id: 1,
          at: AT,
          text: 'Sara moved “Water bill” to the Trash',
          notable: false,
          document_id: null,
        },
      ],
    });
    const table = await screen.findByRole('table');
    expect(await within(table).findByText(whenExactly(AT, 'Europe/London'))).toBeInTheDocument();
    expect(within(table).queryByText(/BST/)).toBeNull();
  });

  it('a document’s page: its dates as written, its history on the family’s clock, across the date line', async () => {
    const doc = {
      ...PASSPORT,
      issued: { date: '2026-03-29', precision: 'day' },
      expires: { date: '2026-12-31', precision: 'day' },
    };
    const seen: Record<string, string[]> = {};
    for (const [browser, family] of [
      ['Pacific/Pago_Pago', 'Pacific/Kiritimati'],
      ['Pacific/Kiritimati', 'Pacific/Pago_Pago'],
    ] as const) {
      browserIn(browser);
      open('/documents/doc-1', { documents: [doc], timezone: family });
      await screen.findByRole('heading', { name: "Mansoor's passport" });
      const facts = [...document.querySelectorAll('dl.facts dd')].map((d) => d.textContent ?? '');
      seen[family] = facts;
      expect(facts).toContain('29 Mar 2026');
      expect(facts).toContain('31 Dec 2026');
      // Uploaded 09:14 UTC on 20 September: 23:14 that day in Kiritimati,
      // 22:14 on the 19th in Pago Pago, each named.
      expect(
        await screen.findByText(
          family === 'Pacific/Kiritimati'
            ? /20 Sept 2026, 11:14pm GMT\+14/
            : /19 Sept 2026, 10:14pm GMT-11/,
        ),
      ).toBeInTheDocument();
      cleanup();
    }
  });
});

describe('a tab left open: the newest zone the tab has heard (the TZ review)', () => {
  const ACTIVITY = [
    {
      id: 1,
      at: AT,
      text: 'Sara moved “Water bill” to the Trash',
      notable: false,
      document_id: null,
    },
  ];
  const profileAsks = (state: FakeState) =>
    state.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/profile').length;
  const comeBack = () =>
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });

  it('asks again as the tab is come back to, at most once a minute, and every screen moves', async () => {
    browserIn('UTC');
    const state = open('/activity', { timezone: 'Europe/London', activity: ACTIVITY });
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('25 Sept 2026, 3:05pm BST')).toBeInTheDocument();
    // An owner changes it on another device.
    state.timezone = 'Asia/Tokyo';
    const asked = profileAsks(state);
    // Back within the minute: not asked again.
    comeBack();
    await new Promise((r) => setTimeout(r, 50));
    expect(profileAsks(state)).toBe(asked);
    // Back after it: asked, and the times move.
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    comeBack();
    expect(await within(table).findByText('25 Sept 2026, 11:05pm GMT+9')).toBeInTheDocument();
    expect(profileAsks(state)).toBe(asked + 1);
  });

  it('a fresh answer from any screen moves them all: Settings → Time zone opened says it', async () => {
    browserIn('UTC');
    const state = open('/activity', { timezone: 'Europe/London', activity: ACTIVITY });
    const table = await screen.findByRole('table');
    await within(table).findByText('25 Sept 2026, 3:05pm BST');
    state.timezone = 'America/New_York';
    act(() => {
      window.history.pushState({}, '', '/settings/time-zone');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: 'Time zone' });
    act(() => {
      window.history.pushState({}, '', '/activity');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(
      await within(await screen.findByRole('table')).findByText('25 Sept 2026, 10:05am EDT'),
    ).toBeInTheDocument();
  });
});

describe('before the vault has answered: the family’s zone as the tab knows it, never UTC (the TZ review)', () => {
  const profileAsked = (state: FakeState) =>
    state.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/profile').length;
  it('a link’s end is named by the same rule as every time: by the clock, not the name (the TZ review)', async () => {
    // Dublin's clock reads as London's: nothing is added.
    browserIn('Europe/Dublin');
    open('/documents/doc-1', { timezone: 'Europe/London' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('group', { name: 'Stops working' });
    fireEvent.click(screen.getByRole('button', { name: 'Friday 5 pm' }));
    expect(screen.getByText(/^Until Friday \d+ \w+ at 17:00\.$/)).toBeInTheDocument();
    cleanup();
    // The action row remembers Share open (0.9.0): begun again folded, as the first time.
    localStorage.clear();
    // Los Angeles' does not: the zone's short name, as everywhere else.
    browserIn('America/Los_Angeles');
    open('/documents/doc-1', { timezone: 'Europe/London' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('group', { name: 'Stops working' });
    fireEvent.click(screen.getByRole('button', { name: 'Friday 5 pm' }));
    expect(screen.getByText(/^Until Friday \d+ \w+ at 17:00 (BST|GMT)\.$/)).toBeInTheDocument();
  });

  it('a guest’s end is said on the family’s clock while the vault is slow to say it again', async () => {
    browserIn('UTC');
    let answer: () => void = () => undefined;
    const state = open('/', {
      timezone: 'Asia/Tokyo',
      guests: [
        {
          id: 'g-1',
          display_name: 'Jane Smith',
          relationship: 'attorney',
          kind: 'guest',
          role: 'viewer',
          has_account: true,
          is_me: false,
          is_deceased: false,
          colour: 3,
          document_count: 0,
          access_expires_at: '2026-11-02T14:30:00Z',
          restriction: null,
        },
      ],
    });
    await waitFor(() => expect(profileAsked(state)).toBeGreaterThan(0));
    await screen.findByRole('heading', { level: 1 });
    state.holdProfile = new Promise<void>((r) => {
      answer = r;
    });
    act(() => {
      window.history.pushState({}, '', '/people/outside');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    // 14:30 UTC is 23:30 in Tokyo.
    expect(await screen.findByText(/^Their access ends /)).toHaveTextContent(
      'Their access ends Monday 2 November 2026 at 23:30 GMT+9.',
    );
    answer();
  });

  it('a link’s end is on the family’s clock when the vault fails to say it again, never UTC', async () => {
    browserIn('UTC');
    const state = open('/', { timezone: 'Asia/Tokyo' });
    await screen.findByRole('heading', { level: 1 });
    // The tab has heard the family's zone; the vault then fails to say it.
    await waitFor(() => expect(profileAsked(state)).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    state.failProfile = true;
    act(() => {
      window.history.pushState({}, '', '/documents/doc-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('group', { name: 'Stops working' });
    fireEvent.click(screen.getByRole('button', { name: 'Friday 5 pm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.method === 'POST' && c.url.endsWith('/share'))).toBe(true),
    );
    const sent = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/share'))?.body as {
      expires_at: string;
    };
    const friday = shareQuickPicks('Asia/Tokyo').find((p) => p.key === 'friday')?.at;
    expect(sent.expires_at).toBe(friday?.toISOString());
  });
});

describe('Settings → Time zone', () => {
  const tzPage = async () =>
    (await screen.findByRole('heading', { level: 1, name: 'Time zone' })).closest(
      'main',
    ) as HTMLElement;

  it('an owner finds a zone, sees its offset and its time now, and the whole app moves to it', async () => {
    browserIn('America/Los_Angeles');
    const state = open('/settings/time-zone', {
      timezone: 'UTC',
      activity: [
        {
          id: 1,
          at: AT,
          text: 'Sara moved “Water bill” to the Trash',
          notable: false,
          document_id: null,
        },
      ],
    });
    const page = await tzPage();
    expect(await within(page).findByText(inDd(/^UTC, GMT, \d\d:\d\d now$/))).toBeInTheDocument();
    expect(within(page).getByText('The server’s default (FDV_TIMEZONE: UTC)')).toBeInTheDocument();
    expect(
      within(page).getByText(/^Every time the vault shows is on this clock/),
    ).toBeInTheDocument();
    // Found by name: each with its offset and its time now.
    fireEvent.change(within(page).getByLabelText('Find a time zone'), {
      target: { value: 'london' },
    });
    const list = within(page).getByRole('group', { name: 'Time zone' });
    const options = () =>
      within(list)
        .getAllByRole('radio')
        .map((r) => (r.closest('label')?.textContent ?? '').trim());
    expect(options()).toContainEqual(
      expect.stringMatching(/^Europe\/London, GMT\+?\d*, \d\d:\d\d now$/),
    );
    // The zone in use stays listed, whatever is typed; only London matches.
    expect(options().filter((o) => !o.startsWith('UTC'))).toHaveLength(1);
    // Or by offset.
    fireEvent.change(within(page).getByLabelText('Find a time zone'), {
      target: { value: 'GMT+9' },
    });
    expect(options()).toContainEqual(expect.stringMatching(/^Asia\/Tokyo, GMT\+9, /));
    fireEvent.click(within(list).getByRole('radio', { name: /^Asia\/Tokyo,/ }));
    await expectAccessible();
    fireEvent.click(within(page).getByRole('button', { name: 'Use Asia/Tokyo' }));
    const said = await within(page).findByText('Saved. Times are now shown on Asia/Tokyo.');
    await waitFor(() => expect(said).toHaveFocus());
    expect(state.timezoneSaves).toEqual(['Asia/Tokyo']);
    expect(within(page).getByText('An owner, for the family')).toBeInTheDocument();
    // Every screen moves to it at once.
    act(() => {
      window.history.pushState({}, '', '/activity');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('25 Sept 2026, 11:05pm GMT+9')).toBeInTheDocument();
  });

  it('this browser’s zone in one go, and the server’s default again', async () => {
    browserIn('America/Los_Angeles');
    const state = open('/settings/time-zone', {
      timezone: 'Europe/London',
      timezoneSource: 'household',
      serverTimezone: 'America/New_York',
    });
    const page = await tzPage();
    fireEvent.click(
      await within(page).findByRole('button', {
        name: 'Use this browser’s zone (America/Los_Angeles)',
      }),
    );
    await within(page).findByText('Saved. Times are now shown on America/Los_Angeles.');
    // In this browser's zone now: not offered again.
    expect(within(page).queryByRole('button', { name: /Use this browser’s zone/ })).toBeNull();
    fireEvent.click(
      within(page).getByRole('button', {
        name: 'Use the server’s default (FDV_TIMEZONE: America/New_York)',
      }),
    );
    await within(page).findByText(
      'Saved. The family uses the server’s default again: America/New_York.',
    );
    expect(state.timezoneSaves).toEqual(['America/Los_Angeles', null]);
    expect(within(page).queryByRole('button', { name: /server’s default/ })).toBeNull();
  });

  it.each(['adult', 'teen', 'viewer'] as const)(
    'a %s reads the family’s zone, and cannot change it',
    async (role) => {
      browserIn('UTC');
      const state = open(
        '/settings/time-zone',
        { timezone: 'Europe/London', timezoneSource: 'household' },
        role,
      );
      const page = await tzPage();
      expect(
        await within(page).findByText(inDd(/^Europe\/London, GMT\+?\d*, \d\d:\d\d now$/)),
      ).toBeInTheDocument();
      expect(
        within(page).getByText('Only an owner can change the family’s time zone.'),
      ).toBeInTheDocument();
      expect(within(page).queryByLabelText('Find a time zone')).toBeNull();
      expect(within(page).queryByRole('button', { name: /^Use / })).toBeNull();
      expect(state.timezoneSaves ?? []).toEqual([]);
      await expectAccessible();
    },
  );
});
