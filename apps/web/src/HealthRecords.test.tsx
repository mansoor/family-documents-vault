import {
  MAIL_IN_HEALTH_NOTE,
  recordNoPreviewWords,
  sensitiveBackupsWords,
  sensitiveLinkStartWords,
} from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { BatchUploads } from './batch-store.js';
import { folderRecordsLeftOutWords, takenKind } from './batch-upload.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Sharing with doctors, formats, backups (0.9.0, H5), on the web: a
 * sensitive document's link starts view-only for a week, and says why; who
 * opened a link, when, a tap away — and for the person a sensitive paper
 * belongs to, every link to it; a health record kept as it is says "No
 * preview"; moving a sensitive one to the Trash says how long backups hold
 * it.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SENSITIVE = { ...PASSPORT, sensitive: null, sensitive_effective: true };
const DAY = 864e5;
const made = Date.parse('2026-11-10T09:00:00Z');
const LINK = {
  id: 'sh-1',
  document_id: PASSPORT.id,
  document_title: "Mansoor's passport",
  collection_id: null,
  collection_name: null,
  recipient_label: 'Dr Patel',
  created_by_name: 'Mansoor Seikh',
  created_at: new Date(made).toISOString(),
  expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
  has_pin: false,
  open_count: 2,
  last_opened_at: new Date(made + DAY).toISOString(),
  state: 'active',
  flow: 'v2',
  permission: 'view',
  max_opens: null,
  protection: [],
  mine: true,
  summary: 'Shared with Dr Patel, opened twice.',
};

function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'adult' | 'teen' = 'owner',
) {
  const state = fresh({ documents: [{ ...SENSITIVE }], timezone: 'Europe/London', ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('a sensitive document’s link (H5)', () => {
  it('starts view-only for a week, says why, and goes as view unless changed', async () => {
    const state = at(`/documents/${PASSPORT.id}`, { sensitive: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const view = await screen.findByRole('button', { name: 'View' });
    expect(view).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(sensitiveLinkStartWords({ viewable: true }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => null);
    if (dialog) {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Share it anyway' }));
    }
    await screen.findByRole('button', { name: 'Copy the link' });
    const sent = state.calls.filter(
      (c) => c.method === 'POST' && c.url === `/api/v1/documents/${PASSPORT.id}/share`,
    );
    const raw = sent.at(-1)?.body;
    const body = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ permission: 'view' });
    // A week from now, near enough.
    const end = Date.parse(String((body as { expires_at?: string }).expires_at));
    expect(Math.abs(end - (Date.now() + 7 * DAY))).toBeLessThan(DAY);
  });

  it('one that is not sensitive starts to download, as before', async () => {
    at(`/documents/${PASSPORT.id}`, { documents: [{ ...PASSPORT }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    expect(await screen.findByRole('button', { name: 'View and download' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText(/so the link starts as view-only/)).toBeNull();
  });
});

describe('who opened a link, when (H5)', () => {
  it('lists each opening beside the link, a tap away, never an address', async () => {
    const state = at('/sharing', {
      shares: [{ ...LINK }],
      linkOpenings: {
        [LINK.id]: [
          { at: new Date(made + 2 * DAY).toISOString(), device: 'Safari on an iPhone' },
          { at: new Date(made + DAY).toISOString(), device: 'Chrome on a Windows computer' },
        ],
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Who opened the link for Dr Patel, when' }),
    );
    const list = await screen.findByRole('list', { name: 'Who opened it, when' });
    const lines = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Opened .*, in Safari on an iPhone$/);
    expect(lines[1]).toMatch(/, in Chrome on a Windows computer$/);
    expect(state.calls.some((c) => c.url === `/api/v1/shares/${LINK.id}/opens`)).toBe(true);
  });

  it('shows the person a sensitive paper belongs to every link to it, whoever made it', async () => {
    at(
      `/documents/${PASSPORT.id}`,
      {
        sensitive: true,
        linkOpenings: {},
        docLinkOpens: {
          [PASSPORT.id]: [
            {
              share_id: 'sh-theirs',
              recipient_label: 'the clinic',
              created_by_name: 'Sana',
              mine: false,
              permission: 'view',
              created_at: new Date(made).toISOString(),
              expires_at: new Date(Date.now() + 3 * DAY).toISOString(),
              state: 'active',
              open_count: 1,
              opens: [{ at: new Date(made + DAY).toISOString(), device: 'Firefox on a Mac' }],
            },
          ],
        },
      },
      'adult',
    );
    const card = await screen.findByRole('region', { name: 'Shared outside the family' });
    expect(within(card).getByText('the clinic')).toBeInTheDocument();
    expect(within(card).getByText(/made by Sana/)).toBeInTheDocument();
    const list = within(card).getByRole('list', {
      name: 'Who opened the link for the clinic, when',
    });
    expect(within(list).getByText(/, in Firefox on a Mac$/)).toBeInTheDocument();
  });
});

describe('a teen’s sensitive paper in a shared collection (H5 review)', () => {
  it('is on their Shared outside the family card, with who opened the collection’s link', async () => {
    at(
      `/documents/${PASSPORT.id}`,
      {
        sensitive: true,
        linkOpenings: {},
        docLinkOpens: {
          [PASSPORT.id]: [
            {
              share_id: 'sh-school',
              recipient_label: 'the school nurse',
              created_by_name: 'Mansoor Seikh',
              mine: false,
              permission: 'download',
              created_at: new Date(made).toISOString(),
              expires_at: new Date(Date.now() + 3 * DAY).toISOString(),
              state: 'active',
              open_count: 1,
              opens: [{ at: new Date(made + DAY).toISOString(), device: 'Safari on an iPad' }],
            },
          ],
        },
      },
      'teen',
    );
    const card = await screen.findByRole('region', { name: 'Shared outside the family' });
    expect(within(card).getByText('the school nurse')).toBeInTheDocument();
    expect(within(card).getByText(/, in Safari on an iPad$/)).toBeInTheDocument();
  });
});

describe('Add many and health records (H5 review)', () => {
  const file = (name: string, type = '') => new File(['x'], name, { type });

  it('a folder’s records are left out and counted; chosen on their own, they go', () => {
    const store = new BatchUploads();
    store.choose(
      [
        { file: file('IMG_0001.jpg', 'image/jpeg'), path: '/Takeout/Photos/IMG_0001.jpg' },
        {
          file: file('IMG_0001.jpg.json', 'application/json'),
          path: '/Takeout/Photos/IMG_0001.jpg.json',
        },
        { file: file('notes.xml', 'text/xml'), path: '/Takeout/notes.xml' },
      ],
      { limit: 1e9, already: 0, folders: true },
    );
    const got = store.get();
    expect(got.chosen.map((c) => [c.file.name, c.state])).toEqual([['IMG_0001.jpg', 'ready']]);
    expect(got.recordsLeftOut).toBe(2);
    expect(folderRecordsLeftOutWords(2)).toBe(
      '2 files in the folder look like health records (XML, JSON, DICOM or ZIP) and were left out: health record files are added one at a time. Choose them with Choose files.',
    );

    store.choose(
      [file('export.json', 'text/plain'), file('IM00001'), file('notes.txt', 'text/plain')],
      {
        limit: 1e9,
        already: 0,
      },
    );
    const after = store.get().chosen.map((c) => [c.file.name, c.state]);
    expect(after).toEqual([
      ['IMG_0001.jpg', 'ready'],
      ['export.json', 'ready'],
      // No type and no ending, chosen on its own: the vault decides from its bytes.
      ['IM00001', 'ready'],
      ['notes.txt', 'refused'],
    ]);
    expect(takenKind(file('IM00001'), false)).toBe(false);
  });
});

describe('a health record kept as it is (H5)', () => {
  it('says there is no preview, and why', async () => {
    at(`/documents/${PASSPORT.id}`, {
      documents: [{ ...PASSPORT }],
      versionMime: 'application/xml',
    });
    expect(await screen.findByText(recordNoPreviewWords('application/xml'))).toBeInTheDocument();
  });
});

describe('a sensitive document moved to the Trash (H5)', () => {
  it('says older backups hold it, and for how long', async () => {
    at(`/documents/${PASSPORT.id}`, { sensitive: true, backupDays: 30 });
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    fireEvent.click(screen.getByRole('button', { name: 'Move to the Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    expect(
      within(dialog).getByText(sensitiveBackupsWords(30, { forGood: false })),
    ).toBeInTheDocument();
  });

  it('says "until your backups age out" when the vault doesn’t know', async () => {
    at(`/documents/${PASSPORT.id}`, { sensitive: true });
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    fireEvent.click(screen.getByRole('button', { name: 'Move to the Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    await waitFor(() =>
      expect(within(dialog).getByText(/until your backups age out\.$/)).toBeInTheDocument(),
    );
  });
});

describe('email in (H5)', () => {
  it('the note says a forwarded record has already passed through the email provider', () => {
    expect(MAIL_IN_HEALTH_NOTE).toMatch(/already passed through your email provider/);
  });
});
