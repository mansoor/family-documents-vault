import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AiReaderSaved, AiReaderView } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * The AI reader set in Settings → Reading (0.9.0, AIR1), on the web: an
 * owner sets the kind, address, model, key, timeout and limit; the key is
 * never shown back, only that one is set and its last four; saved, it waits
 * for a Test, which says how long it took and where it runs, never what the
 * reader answered; .env's reader is shown locked; and whoever adds papers is
 * told which reader reads them, and where it runs.
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

const NONE: AiReaderView = {
  source: 'settings',
  kinds: ['ollama'],
  env: null,
  reader: null,
  https_only: false,
};

const SAVED: AiReaderSaved = {
  kind: 'ollama',
  base_url: 'http://192.168.1.30:11434',
  model: 'qwen2.5:3b-instruct',
  timeout_seconds: 120,
  runs_at: 'own_network',
  api_key: 'set',
  api_key_last4: 'WXYZ',
  monthly_cap: 500,
  status: 'ok',
  last_tested_at: '2026-11-12T10:00:00.000Z',
  last_problem: null,
  updated_at: '2026-11-12T09:59:00.000Z',
};

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** The card, once it has loaded. */
const card = async () => {
  const c = (await screen.findByRole('heading', { name: 'The AI reader' })).closest(
    'section',
  ) as HTMLElement;
  await waitFor(() => expect(c).not.toHaveTextContent('Loading…'));
  return c;
};

describe('Settings → Reading → the AI reader (AIR1)', () => {
  it('is set here, saved untested, its key never shown back; Test says how long and where it runs', async () => {
    const state = at('/settings/reading', {
      aiReader: NONE,
      localAi: { local_ai: false, local_ai_server: { state: 'not_set_up' } },
      aiReaderTestAnswer: {
        problem: null,
        model: 'qwen2.5:3b-instruct',
        host: '192.168.1.30:11434',
        latency_ms: 1200,
        runs_at: 'own_network',
        words: 'qwen2.5:3b-instruct answered in 1.2 seconds.',
      },
    });
    const c = await card();
    expect(within(c).getByTestId('ai-reader-status')).toHaveTextContent('No AI reader is set up');
    // What is sent, and to whom: the words, never the page; kinds and names.
    expect(c).toHaveTextContent('never the page itself, or the file');
    expect(c).toHaveTextContent('the household’s kinds of document, and the family’s names');
    fireEvent.change(within(c).getByLabelText('Address'), {
      target: { value: 'http://192.168.1.30:11434' },
    });
    fireEvent.change(within(c).getByLabelText('Model'), {
      target: { value: 'qwen2.5:3b-instruct' },
    });
    fireEvent.change(within(c).getByLabelText('API key (if it needs one)'), {
      target: { value: 'sk-test-abcd-WXYZ' },
    });
    fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
    expect(
      await within(c).findByText('Saved. Now test it: no paper is sent to it until a Test passes.'),
    ).toBeInTheDocument();
    expect(state.aiReaderSaves).toEqual([
      {
        kind: 'ollama',
        base_url: 'http://192.168.1.30:11434',
        model: 'qwen2.5:3b-instruct',
        timeout_seconds: 120,
        monthly_cap: 500,
        api_key: 'sk-test-abcd-WXYZ',
      },
    ]);
    // Never shown back: set, ending WXYZ, and the field empty.
    expect(within(c).getByLabelText('API key (if it needs one)')).toHaveValue('');
    expect(c).toHaveTextContent('One is saved, ending WXYZ, and never shown.');
    expect(c).not.toHaveTextContent('sk-test-abcd');
    expect(within(c).getByTestId('ai-reader-status')).toHaveTextContent('not yet tested');
    fireEvent.click(within(c).getByRole('button', { name: 'Test the AI reader' }));
    expect(
      await within(c).findByText(
        /answered in 1\.2 seconds\. It runs on your own network\./,
        {},
        {
          timeout: 4000,
        },
      ),
    ).toBeInTheDocument();
    expect(state.checksAsked).toEqual([{ kind: 'ai_reader', path: null }]);
    await waitFor(() =>
      expect(within(c).getByTestId('ai-reader-status')).toHaveTextContent('Working'),
    );
    await expectAccessible();
  });

  it('takes the address alone: a path, a sign-in or another scheme is refused before it is sent', async () => {
    const state = at('/settings/reading', { aiReader: NONE });
    const c = await card();
    fireEvent.change(within(c).getByLabelText('Model'), { target: { value: 'llama3.2' } });
    for (const [typed, words] of [
      ['http://192.168.1.30:11434/api/chat', /the vault adds the rest/],
      ['http://me:pw@192.168.1.30:11434', /no user name or password/],
      ['ftp://192.168.1.30', /starts with http:\/\/ or https:\/\//],
    ] as const) {
      fireEvent.change(within(c).getByLabelText('Address'), { target: { value: typed } });
      fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
      expect(await within(c).findByRole('alert')).toHaveTextContent(words);
    }
    expect(state.aiReaderSaves).toBeUndefined();
  });

  it('a Test that failed says why in the vault’s own words', async () => {
    at('/settings/reading', {
      aiReader: { ...NONE, reader: { ...SAVED, status: 'untested', last_tested_at: null } },
      aiReaderTestAnswer: {
        problem: 'bad_reply',
        model: 'qwen2.5:3b-instruct',
        host: '192.168.1.30:11434',
        latency_ms: null,
        words:
          'Something answered, but not as that kind of reader does. Check the address is the reader’s own.',
      },
    });
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Test the AI reader' }));
    expect(
      await within(c).findByText(/not as that kind of reader does/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('finds the models it has, by name, to pick one', async () => {
    at('/settings/reading', {
      aiReader: { ...NONE, reader: SAVED },
      aiModelsAnswer: {
        problem: null,
        models: ['llama3.2:3b', 'qwen2.5:3b-instruct'],
        words: 'It has 2 models.',
      },
    });
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Find its models' }));
    const pick = await within(c).findByLabelText('Models it has', {}, { timeout: 4000 });
    fireEvent.change(pick, { target: { value: 'llama3.2:3b' } });
    expect(within(c).getByLabelText('Model')).toHaveValue('llama3.2:3b');
    expect(c).toHaveTextContent('It has 2 models.');
  });

  it('a cloud service is said plainly', async () => {
    at('/settings/reading', {
      aiReader: {
        ...NONE,
        reader: { ...SAVED, base_url: 'https://reader.example.com', runs_at: 'cloud' },
      },
    });
    const c = await card();
    expect(c).toHaveTextContent('This reader is a cloud service: your papers’ words leave');
    expect(within(c).getByTestId('ai-reader-status')).toHaveTextContent('as a cloud service');
    await expectAccessible();
  });

  it('asks before it is removed', async () => {
    const state = at('/settings/reading', { aiReader: { ...NONE, reader: SAVED } });
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Remove the AI reader' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the AI reader?' });
    expect(state.aiReader?.reader).not.toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(state.aiReader?.reader).toBeNull());
  });

  it('.env’s reader wins, shown locked: nothing to type', async () => {
    at('/settings/reading', {
      aiReader: {
        ...NONE,
        source: 'env',
        env: { kind: 'ollama', model: 'env-model', host: 'ollama:11434', runs_at: 'own_network' },
      },
    });
    const c = await card();
    expect(within(c).getByTestId('ai-reader-locked')).toHaveTextContent(
      'Set by whoever runs this server, in its .env file: Local (Ollama), on your own network, at ollama:11434, model env-model. It can’t be changed here.',
    );
    expect(within(c).queryByRole('textbox')).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('not offered (FDV_AI_READER_SETTINGS=off, or an older vault): no card', async () => {
    at('/settings/reading', {
      localAi: { local_ai: false, local_ai_server: { state: 'not_set_up' } },
    });
    await screen.findByRole('heading', { name: 'The local AI' });
    expect(screen.queryByRole('heading', { name: 'The AI reader' })).toBeNull();
  });

  it('the household’s switch turns on the reader saved, once tested; whoever adds papers is told which and where', async () => {
    const state = at('/settings/reading', {
      aiReader: { ...NONE, reader: SAVED },
      localAi: { local_ai: false, local_ai_server: { state: 'not_set_up' } },
    });
    expect(
      await screen.findByText(
        /Set in Settings: Local \(Ollama\): qwen2\.5:3b-instruct at 192\.168\.1\.30:11434, on your own network\. Its last Test passed\./,
      ),
    ).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: /with the local AI too/ });
    expect(box).not.toBeDisabled();
    fireEvent.click(box);
    await waitFor(() => expect(state.localAi?.local_ai).toBe(true));
    cleanup();
    at(
      '/add/many',
      {
        batches: [],
        aiReader: { ...NONE, reader: SAVED },
        localAi: { local_ai: true, local_ai_server: { state: 'not_set_up' } },
      },
      'adult',
    );
    expect(await screen.findByText(/Read by the household’s local AI, on/)).toHaveTextContent(
      'Read by the household’s local AI, on 192.168.1.30:11434 (Local (Ollama), on your own network), beside the vault’s rules.',
    );
  });
});
