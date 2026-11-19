import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLinkPage } from './screens/AppLinkPage.js';
import { fresh, installFakeApi } from './test-api.js';

/**
 * The page a connected app's view link opens (0.9.0, APP3): the drawn pages
 * of one document, with the app's name across the top, and nothing of the
 * family's app around it; or, when the link was used, has ended or was
 * opened from another network, that — never why.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/a');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const ENDS = new Date(Date.now() + 10 * 60_000).toISOString();

describe('a connected app’s link’s page (APP3)', () => {
  it('shows the pages, opened through the app, and until when', async () => {
    installFakeApi(
      fresh({
        appLink: {
          app: 'Acme Money',
          mode: 'view',
          title: 'Northgate statement, Oct 2026',
          pages: { state: 'ready', count: 2 },
          ends_at: ENDS,
          opened_on: '2026-11-19',
        },
      }),
    );
    render(<AppLinkPage hash="" />);
    expect(
      await screen.findByRole('heading', { name: 'Northgate statement, Oct 2026' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Opened through Acme Money');
    const pages = screen.getByRole('list', { name: 'The pages of Northgate statement, Oct 2026' });
    const images = pages.querySelectorAll('img');
    expect([...images].map((i) => i.getAttribute('src'))).toEqual([
      '/api/v1/app-links/session/pages/1',
      '/api/v1/app-links/session/pages/2',
    ]);
    expect(screen.getByAltText('Page 1 of 2')).toBeInTheDocument();
    expect(
      screen.getByText(/After that, open the document again from Acme Money\./),
    ).toBeInTheDocument();
    // Never the file: there is nothing to download here.
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    await waitFor(() => expect(document.title).toMatch(/^A document – /));
    await expectAccessible();
  });

  it('carries a light watermark across each page: the app and the day, over the page, never in it (0.9.0-dev.68)', async () => {
    installFakeApi(
      fresh({
        appLink: {
          app: 'Acme Money',
          mode: 'view',
          title: 'Northgate statement, Oct 2026',
          pages: { state: 'ready', count: 2 },
          ends_at: ENDS,
          opened_on: '2026-11-19',
        },
      }),
    );
    render(<AppLinkPage hash="" />);
    await screen.findByAltText('Page 1 of 2');
    const marks = screen.getAllByTestId('app-link-watermark');
    // One over each page, beside its picture: the picture is the vault's
    // drawing, untouched.
    expect(marks).toHaveLength(2);
    for (const [i, mark] of marks.entries()) {
      const page = mark.closest('li');
      expect(page).toHaveClass('app-link-page');
      expect(mark.parentElement).toBe(page);
      expect(page?.querySelector('img')?.getAttribute('src')).toBe(
        `/api/v1/app-links/session/pages/${i + 1}`,
      );
      // Repeated, in the family's date format, and hidden from a screen
      // reader, which hears the same from the line at the top.
      const lines = [...mark.querySelectorAll('span')].map((x) => x.textContent ?? '');
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) {
        expect(line).toContain('Opened through Acme Money · 19 November 2026');
      }
      expect(mark).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.getByAltText('Page 2 of 2')).toBeInTheDocument();
    await expectAccessible();
  });

  it('draws its watermark letting every click through, low in contrast, over the page (CSS)', () => {
    const file = ['src/styles.css', 'apps/web/src/styles.css']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    const css = (file ? readFileSync(file, 'utf8') : '').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) =>
      [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1]?.trim() === selector)?.[2] ?? '';
    const mark = rule('.app-link-watermark');
    expect(mark).toMatch(/position:\s*absolute/);
    expect(mark).toMatch(/inset:\s*0/);
    expect(mark).toMatch(/pointer-events:\s*none/);
    expect(mark).toMatch(/user-select:\s*none/);
    expect(mark).toMatch(/overflow:\s*hidden/);
    const opacity = Number(/opacity:\s*([\d.]+)/.exec(mark)?.[1]);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThanOrEqual(0.2);
    expect(rule('.app-link-page')).toMatch(/position:\s*relative/);
  });

  it('says the pages are being prepared while they are drawn', async () => {
    installFakeApi(
      fresh({
        appLink: {
          app: 'Acme Money',
          mode: 'view',
          title: null,
          pages: { state: 'drawing', count: 0 },
          ends_at: ENDS,
          opened_on: '2026-11-19',
        },
      }),
    );
    render(<AppLinkPage hash="" />);
    expect(await screen.findByRole('heading', { name: 'A document' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Preparing the pages/);
  });

  it('a request that fails while the pages are drawn is asked again, waiting longer, until they come', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const drawing = {
        app: 'Acme Money',
        mode: 'view' as const,
        title: 'A bill',
        pages: { state: 'drawing' as const, count: 0 },
        ends_at: ENDS,
        opened_on: '2026-11-19',
      };
      const state = fresh({ appLink: drawing });
      installFakeApi(state);
      render(<AppLinkPage hash="" />);
      expect(await screen.findByText(/Preparing the pages/)).toHaveAttribute('role', 'status');
      // The next ask fails, and the one after it too.
      state.appLinkFailures = 2;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(state.appLinkFailures).toBe(0);
      expect(screen.getByRole('status')).toHaveTextContent(/Preparing the pages/);
      // Drawn meanwhile: the next ask, later still, shows them.
      state.appLink = { ...drawing, pages: { state: 'ready', count: 1 } };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(await screen.findByAltText('Page 1 of 1')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on pages never drawn after a few minutes, on its own timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const state = fresh({
        appLink: {
          app: 'Acme Money',
          mode: 'view',
          title: 'A bill',
          pages: { state: 'drawing', count: 0 },
          ends_at: ENDS,
          opened_on: '2026-11-19',
        },
      });
      installFakeApi(state);
      render(<AppLinkPage hash="" />);
      expect(await screen.findByText(/Preparing the pages/)).toHaveAttribute('role', 'status');
      // Every ask fails from here: the page still gives up in time.
      state.appLinkFailures = 1000;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent(/could not be prepared/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a link used, ended or opened elsewhere: the page says so, never why', async () => {
    installFakeApi(fresh());
    for (const [hash, words] of [
      ['#used', /used or has ended/],
      ['#ended', /used or has ended/],
      ['#elsewhere', /from another network/],
      ['#full', /isn’t available today/],
    ] as const) {
      const { unmount } = render(<AppLinkPage hash={hash} />);
      expect(
        await screen.findByRole('heading', { name: 'This document cannot be shown' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(words);
      unmount();
    }
    // No session at all: the vault says it ended.
    render(<AppLinkPage hash="" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/used or has ended/);
    await expectAccessible();
  });

  it('opened from another network: told so', async () => {
    installFakeApi(fresh({ appLink: 'elsewhere' }));
    render(<AppLinkPage hash="" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/from another network/);
  });
});
