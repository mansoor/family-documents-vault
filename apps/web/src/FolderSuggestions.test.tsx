import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  levelItem,
  suggestFromFolder,
  type BatchDefaults,
  type BatchItemView,
  type DetailProposal,
  type DocumentTypeView,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  signedIn,
  type FakeBatch,
  type FakeState,
} from './test-api.js';

/**
 * Folder names → suggested details (0.8.0, S2), on the web: Add → Many
 * documents sends where each file was under the folder chosen or dropped —
 * the top folder's name dropped when it is only a container — to a vault
 * that keeps it, and nothing to one that does not; the batch page says the
 * folder under each file's name; the card marks a detail the folder
 * suggested ("suggested from the folder ‘Passports/Aisha’"), says where the
 * folder agrees with the pages, and offers a new tag from the folder's name.
 */

const WIDE = 1280;

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || px >= Number(minWidth[1])) &&
          (!minHeight || 900 >= Number(minHeight[1])) &&
          Boolean(minWidth || minHeight),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const pdf = (name: string) =>
  new File([`%PDF-1.4\n% ${name}\n%%EOF\n`], name, { type: 'application/pdf' });
/** A file as a chosen folder gives it: where it was under the folder, with its own name. */
const inFolder = (path: string) => {
  const f = pdf(path.split('/').pop() as string);
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
};

const posted = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'POST' && /\/items$/.test(c.url))
    .map((c) => c.body as { file: string; relative_path?: string });

function addMany(over: Partial<FakeState> = {}): FakeState {
  atWidth(WIDE);
  const state = fresh({ members: [{ ...ME, role: 'owner' }, AISHA], batches: [], ...over });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', '/add/many');
  render(<App />);
  return state;
}

describe('Add many documents, from a folder (S2)', () => {
  it('a folder chosen sends where each file was, its container top dropped; a file chosen alone sends none', async () => {
    const state = addMany();
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    fireEvent.change(screen.getByLabelText('Choose a folder'), {
      target: {
        files: [inFolder('Scans/Passports/Aisha/p1.pdf'), inFolder('Aisha/Bills/2024/b1.pdf')],
      },
    });
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files: [pdf('alone.pdf')] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Start: upload 3 files' }));
    await screen.findByText('Open the batch');
    expect(posted(state)).toEqual([
      { relative_path: 'Passports/Aisha', file: 'p1.pdf' },
      // "Aisha" at the top says whose: kept.
      { relative_path: 'Aisha/Bills/2024', file: 'b1.pdf' },
      { file: 'alone.pdf' },
    ]);
    await expectAccessible();
  });

  it('a folder dropped sends each file’s path under it; a file dropped alone sends none', async () => {
    const state = addMany();
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    const fileEntry = (file: File, fullPath: string) => ({
      isFile: true,
      isDirectory: false,
      fullPath,
      file: (ok: (f: File) => void) => ok(file),
    });
    const dirEntry = (fullPath: string, children: unknown[]) => {
      let given = false;
      return {
        isFile: false,
        isDirectory: true,
        fullPath,
        createReader: () => ({
          readEntries: (ok: (e: unknown[]) => void) => {
            ok(given ? [] : children);
            given = true;
          },
        }),
      };
    };
    const folder = dirEntry('/Insurance', [
      fileEntry(pdf('car.pdf'), '/Insurance/car.pdf'),
      dirEntry('/Insurance/Aisha', [fileEntry(pdf('travel.pdf'), '/Insurance/Aisha/travel.pdf')]),
    ]);
    const single = fileEntry(pdf('loose.pdf'), '/loose.pdf');
    const zone = screen.getByRole('heading', { name: 'Drop files or a folder here' })
      .parentElement as HTMLElement;
    fireEvent.drop(zone, {
      dataTransfer: {
        items: [folder, single].map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
        files: [],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Start: upload 3 files' }));
    await screen.findByText('Open the batch');
    expect(posted(state)).toEqual([
      { relative_path: 'Insurance', file: 'car.pdf' },
      { relative_path: 'Insurance/Aisha', file: 'travel.pdf' },
      { file: 'loose.pdf' },
    ]);
  });

  it('a vault from before 0.8.0 is sent the file alone, as it takes it', async () => {
    const state = addMany({ folderSuggestions: false });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    fireEvent.change(screen.getByLabelText('Choose a folder'), {
      target: { files: [inFolder('Aisha/Passports/p1.pdf')] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Start: upload 1 file' }));
    await screen.findByText('Open the batch');
    expect(posted(state)).toEqual([{ file: 'p1.pdf' }]);
  });
});

// ------------------------------------------------------------- the batch and the card

const DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};
const day = (date: string) => ({ date, precision: 'day' as const });
const PEOPLE = [
  { id: 'me', name: 'Mansoor Seikh' },
  { id: 'm-0', name: 'Aisha' },
];

/** An item from a folder, levelled as the vault levels it: the pages, the folder, the defaults. */
function fromFolder(
  id: string,
  name: string,
  folder: string,
  proposal: DetailProposal,
  types: DocumentTypeView[],
  tags: string[] = [],
): BatchItemView {
  const suggested = suggestFromFolder(folder, { types, people: PEOPLE, tags });
  const levelled = levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal,
    duplicate: null,
    folder: suggested,
    defaults: DEFAULTS,
    types,
    people: PEOPLE,
    role: 'owner',
    me: 'me',
  });
  return {
    id,
    batch_id: 'batch-1',
    name,
    content_type: 'application/pdf',
    byte_size: 2048,
    sha256: id.padEnd(64, '0'),
    arrived_at: '2026-10-06T09:05:00Z',
    state: 'waiting',
    reading: 'read',
    read_failure: null,
    preview_state: 'ready',
    preview_pages: 1,
    duplicate: null,
    document_id: null,
    level: levelled.level,
    tags: levelled.tags,
    proposals: levelled.proposals,
    clashes: levelled.clashes,
    folder,
  };
}

function atBatch(path: string): FakeState {
  atWidth(WIDE);
  const state = fresh({ members: [{ ...ME, role: 'owner' }, AISHA], batches: [] });
  const types = state.types as unknown as DocumentTypeView[];
  const batch: FakeBatch = {
    id: 'batch-1',
    name: 'The filing cabinet',
    created_at: '2026-10-06T09:00:00Z',
    ends_at: '2026-11-05T09:00:00Z',
    defaults: DEFAULTS,
    items: [
      // The folder alone: its kind and whose it is, unsure (the pages gave a date and a number).
      fromFolder(
        'item-1',
        'p1.pdf',
        'Passports/Aisha/Holidays/Greece',
        {
          expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
          identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
        },
        types,
        ['holiday'],
      ),
      // The pages unsure, the folder agreeing.
      fromFolder(
        'item-2',
        'p2.pdf',
        'Passports/Aisha',
        {
          type_key: { value: 'passport', confidence: 0.78, cue: 'kind_words' },
          owner_member_id: { value: 'm-0', confidence: 0.78, cue: 'name_labelled' },
          expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
          identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
        },
        types,
      ),
    ],
  };
  state.batches = [batch];
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('the folder, on the batch page and the card (S2)', () => {
  it('the batch page says the folder under each file’s name, and a kind from the folder alone', async () => {
    atBatch('/inbox/batches/batch-1');
    const table = await screen.findByRole('grid', { name: 'Files in The filing cabinet' });
    const row = (name: string) =>
      within(table)
        .getAllByRole('row')
        .find((r) => r.textContent?.includes(name)) as HTMLElement;
    expect(
      within(row('p1.pdf')).getByText('From the folder Passports/Aisha/Holidays/Greece'),
    ).toBeVisible();
    expect(row('p1.pdf')).toHaveTextContent('Passportfrom the folder');
    expect(row('p1.pdf')).toHaveTextContent('Check');
    expect(within(row('p2.pdf')).getByText('From the folder Passports/Aisha')).toBeVisible();
    expect(row('p2.pdf')).toHaveTextContent('Ready');
    await expectAccessible();
  });

  it('the card marks what the folder suggested, says where it agrees, and offers a new tag from its name', async () => {
    const state = atBatch('/inbox/batches/batch-1/items/item-1');
    const kind = await screen.findByLabelText(/What it is/);
    await screen.findByRole('option', { name: 'Aisha' });
    expect(kind).toHaveValue('passport');
    expect(screen.getByText('From the folder Passports/Aisha/Holidays/Greece')).toBeVisible();
    expect(screen.getByText('What it is').closest('label')).toHaveTextContent(
      'What it is suggested from the folder ‘Passports/Aisha/Holidays/Greece’unsure',
    );
    expect(screen.getByLabelText(/Whose it is/)).toHaveValue('m-0');
    expect(screen.getByText('Whose it is').closest('label')).toHaveTextContent(
      'suggested from the folder',
    );
    // A tag already used starts on the card; a new one is offered.
    expect(screen.getByLabelText('Tags')).toHaveValue('holiday');
    const offer = screen.getByRole('button', {
      name: 'Add the tag greece: a new tag from the folder name',
    });
    await expectAccessible();
    fireEvent.click(offer);
    await waitFor(() => expect(screen.getByLabelText('Tags')).toHaveValue('holiday, greece'));
    expect(
      screen.queryByRole('button', { name: 'Add the tag greece: a new tag from the folder name' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Accept and next/ }));
    await waitFor(() =>
      expect(state.batchAccepts?.find((a) => a.item === 'item-1')?.body).toMatchObject({
        type_key: 'passport',
        owner_member_id: 'm-0',
        tags: ['holiday', 'greece'],
      }),
    );
  });

  it('where the pages and the folder agree, the card says both', async () => {
    atBatch('/inbox/batches/batch-1/items/item-2');
    await screen.findByLabelText(/What it is/);
    await screen.findByRole('option', { name: 'Aisha' });
    expect(screen.getByText('What it is').closest('label')).toHaveTextContent(
      'suggested · 88%and the folder ‘Passports/Aisha’',
    );
    expect(screen.getByText('What it is').closest('label')).not.toHaveTextContent('unsure');
    await expectAccessible();
  });
});
