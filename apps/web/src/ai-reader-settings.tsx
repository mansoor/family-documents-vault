import {
  AI_READER_CAP_DEFAULT,
  AI_READER_CAP_MAX,
  AI_READER_CAP_MIN,
  AI_READER_KIND_NAMES,
  AI_READER_TIMEOUT_DEFAULT,
  AI_READER_TIMEOUT_MAX,
  AI_READER_TIMEOUT_MIN,
  ANTHROPIC_BASE_URL,
  aiReaderAddress,
  aiReaderAddressWords,
  aiReaderMonthWords,
  aiReaderProvider,
  aiReaderRunsAtWords,
  aiReaderSendSensitiveWarning,
  localAiProblemWords,
  type AiReaderKind,
  type AiReaderView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateTimeWords } from './family-time.js';
import { Button, Check, ConfirmDialog, ErrorNote, Field, LoadFailed } from './ui.js';
import { useWorkerCheck } from './worker-check.js';

/**
 * Settings → Reading → AI reader (0.9.0, AIR1), an owner's: which reader
 * reads the family's papers' words when the household's local AI is on —
 * its kind (Local, Ollama; Anthropic, whose address is fixed; or an
 * OpenAI-compatible server, since AIR3), its address, the model, how long a
 * paper may take, and an API key, kept encrypted and never shown again
 * (only that one is set, and its last four characters).
 *
 * Saved, it waits for a Test, which the worker runs — a one-line question of
 * its own, none of your papers — and which must pass before any paper goes
 * to it. What the reader answered is never shown: the vault says how long it
 * took, or why not, in its own words. Where whoever runs the server set a
 * reader in .env, that wins, and it is shown here locked.
 */
export function AiReaderCard() {
  const { caps } = useApp();
  if (caps?.features?.ai_reader_settings !== true) return null;
  return <AiReaderPart />;
}

/** What each kind of reader is, said under the choice (AIR3). */
const KIND_NOTES: Readonly<Record<AiReaderKind, string>> = {
  ollama: 'An Ollama server on this machine or your network.',
  anthropic:
    'Anthropic’s Claude, a cloud service at api.anthropic.com. It needs an API key from your Anthropic account.',
  openai_compatible:
    'OpenAI itself, or a server that speaks its API — LM Studio, vLLM or llama.cpp — on your network.',
};

/** A model's name as each kind of reader writes one. */
const MODEL_EXAMPLES: Readonly<Record<AiReaderKind, string>> = {
  ollama: 'qwen2.5:3b-instruct',
  anthropic: 'claude-haiku-4-5',
  openai_compatible: 'gpt-4o-mini',
};

/**
 * "Also send sensitive papers" (AIR3, decision 6), shown only while the
 * reader is a cloud service: off unless an owner turns it on, with step-up,
 * after the warning that names the provider and says what is sent. Every
 * owner is emailed each time it changes. Only me papers are never sent.
 */
function SendSensitive(props: {
  view: AiReaderView;
  kind: AiReaderKind;
  baseUrl: string | null;
  onSaved: () => Promise<void>;
}) {
  const { guarded } = useApp();
  const on = props.view.send_sensitive === true;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = aiReaderProvider(props.kind, props.baseUrl);
  const set = async (to: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((tk) => api.setAiReaderSendSensitive(tk, { send_sensitive: to }));
      setAsking(false);
      if (done !== null) await props.onSaved();
    } catch (err) {
      setAsking(false);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" data-testid="ai-reader-send-sensitive">
      <h4 id="ai-reader-sensitive-h">Sensitive papers</h4>
      <Check
        id="ai-reader-send-sensitive"
        checked={on}
        disabled={busy}
        label="Also send sensitive papers"
        note={
          on
            ? `On: papers marked Sensitive are sent to ${provider.name} too. Only me papers never are.`
            : `Off: papers marked Sensitive are read on this server alone, never sent to ${provider.name}.`
        }
        onChange={(to) => (to ? setAsking(true) : void set(false))}
      />
      <ErrorNote message={error} />
      {asking && (
        <ConfirmDialog
          title="Send sensitive papers to the AI reader?"
          confirmLabel="Send them too"
          busyLabel="Turning on…"
          danger
          busy={busy}
          onConfirm={() => void set(true)}
          onCancel={() => setAsking(false)}
        >
          <p>{aiReaderSendSensitiveWarning(props.kind, props.baseUrl)}</p>
          {provider.terms && (
            <p>
              <a href={provider.terms} target="_blank" rel="noreferrer noopener">
                {provider.name}’s terms
              </a>
            </p>
          )}
          <p>Every owner is emailed that it was turned on.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** "Local (Ollama), on your own network, at 192.168.1.30:11434". */
function readerWords(kind: AiReaderKind, host: string, runsAt: 'own_network' | 'cloud' | null) {
  return `${AI_READER_KIND_NAMES[kind]}, ${aiReaderRunsAtWords(runsAt)}, at ${host}`;
}

function statusWords(v: AiReaderView): string {
  const r = v.reader;
  if (!r) return 'No AI reader is set up here. Fill in the form, save, then test it.';
  if (r.status === 'ok') {
    return `Working: its last Test passed${r.last_tested_at ? ` ${dateTimeWords(r.last_tested_at)}` : ''}. It runs ${aiReaderRunsAtWords(r.runs_at)}.`;
  }
  if (r.status === 'failed') {
    return `Not working: ${r.last_problem ? localAiProblemWords(r.last_problem) : 'its last Test did not pass.'} No paper is sent to it until a Test passes.`;
  }
  return 'Saved, not yet tested. Test it below: no paper is sent to it until a Test passes.';
}

function AiReaderPart() {
  const { authVersion } = useApp();
  const { data, error, reload } = useLoad((t) => api.aiReader(t), [authVersion]);
  return (
    <section className="card stack" aria-labelledby="ai-reader-h">
      <h3 id="ai-reader-h" style={{ fontSize: 18 }}>
        The AI reader
      </h3>
      {data === null && error ? (
        <LoadFailed message={error} what="the AI reader" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : data.source === 'env' && data.env ? (
        <>
          <p role="status" data-testid="ai-reader-locked">
            Set by whoever runs this server, in its .env file:{' '}
            <bdi>{readerWords(data.env.kind, data.env.host, data.env.runs_at)}</bdi>, model{' '}
            <bdi>{data.env.model}</bdi>. It can’t be changed here.
          </p>
          {data.reader && (
            <p className="muted">
              A reader saved here is kept, but isn’t used while that one is set.
            </p>
          )}
          {data.env.runs_at === 'cloud' && (
            <SendSensitive view={data} kind={data.env.kind} baseUrl={null} onSaved={reload} />
          )}
        </>
      ) : data.source === 'off' ? (
        <p className="muted">Whoever runs this vault keeps the AI reader out of Settings.</p>
      ) : (
        <>
          <p>
            A language model the vault asks to read the papers added many at a time, beside its own
            rules, when the household’s local AI is turned on below. It suggests details for you to
            check, and never makes a document Ready by itself.
          </p>
          <div className="attention" role="note">
            <p>What the vault sends it, to the address saved here and nowhere else:</p>
            <ul>
              <li>
                the words the vault read from each paper — never the page itself, or the file;
              </li>
              <li>the household’s kinds of document, and the family’s names.</li>
            </ul>
            <p>
              Whoever runs the reader may keep what it is sent. A reader on your own network is
              yours; a cloud service keeps what its own terms say.
            </p>
          </div>
          {data.reader?.runs_at === 'cloud' && (
            <p className="attention attention-warn" role="note">
              This reader is a cloud service: your papers’ words leave your network for it. Use a
              reader on your own network if they shouldn’t. Papers marked Sensitive and Only me
              papers are never sent to it, unless you say so below for Sensitive ones.
            </p>
          )}
          <p
            className={data.reader?.status === 'ok' ? 'attention attention-calm' : 'attention'}
            role="status"
            data-testid="ai-reader-status"
          >
            {statusWords(data)}
          </p>
          {data.reader?.runs_at === 'cloud' && data.month && (
            <p className="muted" data-testid="ai-reader-month">
              Papers sent to it: {aiReaderMonthWords(data.month)}. Past that, papers are read by the
              vault’s own rules alone until next month.
            </p>
          )}
          <AiReaderForm view={data} onSaved={reload} />
          {data.reader && <AiReaderTest onTested={reload} />}
          {data.reader?.runs_at === 'cloud' && (
            <SendSensitive
              view={data}
              kind={data.reader.kind}
              baseUrl={data.reader.base_url}
              onSaved={reload}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * The reader itself. The key is sent once and kept encrypted — never shown
 * again, only that one is set and its last four characters; left empty the
 * one saved is kept, unless the address changed, when it is forgotten.
 */
function AiReaderForm(props: { view: AiReaderView; onSaved: () => Promise<void> }) {
  const { guarded } = useApp();
  const r = props.view.reader;
  const kinds = props.view.kinds;
  const [kind, setKind] = useState<AiReaderKind>('ollama');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [forgetKey, setForgetKey] = useState(false);
  const [ownNetwork, setOwnNetwork] = useState(false);
  const [timeout, setTimeoutSecs] = useState(String(AI_READER_TIMEOUT_DEFAULT));
  const [cap, setCap] = useState(String(AI_READER_CAP_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const models = useWorkerCheck();
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // The form starts from what the vault has, each time it is loaded.
    /* eslint-disable react-hooks/set-state-in-effect */
    setKind(r?.kind ?? kinds[0] ?? 'ollama');
    setBaseUrl(r?.base_url ?? '');
    setModel(r?.model ?? '');
    setKey('');
    setForgetKey(false);
    setOwnNetwork(r?.own_network === true);
    setTimeoutSecs(String(r?.timeout_seconds ?? AI_READER_TIMEOUT_DEFAULT));
    setCap(String(r?.monthly_cap ?? AI_READER_CAP_DEFAULT));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [r, kinds]);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);

  // Anthropic's address is fixed (AIR3): never typed.
  const anthropic = kind === 'anthropic';
  const typed = aiReaderAddress(anthropic ? ANTHROPIC_BASE_URL : baseUrl, {
    httpsOnly: props.view.https_only,
  });
  const moved =
    r !== null &&
    r.api_key === 'set' &&
    (r.kind !== kind || (!anthropic && 'url' in typed && typed.url !== r.base_url));
  const found = models.view?.state === 'done' ? (models.view.ai_models ?? null) : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if ('problem' in typed) {
      setError(aiReaderAddressWords(typed.problem));
      document.getElementById('ai-reader-url')?.focus();
      return;
    }
    if (!model.trim()) {
      setError('Type the model’s name as the reader has it, such as qwen2.5:3b-instruct.');
      document.getElementById('ai-reader-model')?.focus();
      return;
    }
    const t = Number(timeout);
    if (!Number.isInteger(t) || t < AI_READER_TIMEOUT_MIN || t > AI_READER_TIMEOUT_MAX) {
      setError(
        `How long a paper may take is a number of seconds from ${AI_READER_TIMEOUT_MIN} to ${AI_READER_TIMEOUT_MAX}.`,
      );
      return;
    }
    const c = Number(cap);
    if (!Number.isInteger(c) || c < AI_READER_CAP_MIN || c > AI_READER_CAP_MAX) {
      setError(
        `The most papers in a month is a number from ${AI_READER_CAP_MIN} to ${AI_READER_CAP_MAX}.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await guarded((tk) =>
        api.setAiReader(tk, {
          kind,
          base_url: anthropic ? null : typed.url,
          model: model.trim(),
          timeout_seconds: t,
          monthly_cap: c,
          ...(key !== '' ? { api_key: key } : forgetKey ? { api_key: null } : {}),
          ...(kind === 'openai_compatible' ? { own_network: ownNetwork } : {}),
        }),
      );
      if (done !== null) {
        setKey('');
        await props.onSaved();
        setSaid(
          done.reader?.status === 'ok'
            ? 'Saved. Its last Test still holds.'
            : 'Saved. Now test it: no paper is sent to it until a Test passes.',
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((tk) => api.removeAiReader(tk));
      setAsking(false);
      if (done !== null) {
        await props.onSaved();
        setSaid('Removed, with its key. No paper is sent to an AI reader set here.');
      }
    } catch (err) {
      setAsking(false);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => void save(e)}
      aria-labelledby="ai-reader-set-h"
      noValidate
    >
      <h4 id="ai-reader-set-h">Set up the AI reader</h4>
      <div className="field">
        <label htmlFor="ai-reader-kind">Kind of reader</label>
        <select
          id="ai-reader-kind"
          value={kind}
          aria-describedby="ai-reader-kind-note"
          onChange={(e) => setKind(e.target.value as AiReaderKind)}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {AI_READER_KIND_NAMES[k]}
            </option>
          ))}
        </select>
        <p id="ai-reader-kind-note" className="muted field-note">
          {KIND_NOTES[kind]}
        </p>
      </div>
      {!anthropic && (
        <Field
          id="ai-reader-url"
          label="Address"
          value={baseUrl}
          placeholder={
            kind === 'openai_compatible'
              ? 'https://api.openai.com'
              : props.view.https_only
                ? 'https://ollama.example.com'
                : 'http://192.168.1.30:11434'
          }
          autoCapitalize="off"
          autoCorrect="off"
          invalid={error !== null && 'problem' in typed}
          note={
            props.view.https_only
              ? 'Its address alone, starting with https://. The vault adds the rest, and calls nothing else there.'
              : 'Its address alone, such as http://192.168.1.30:11434. The vault adds the rest, and calls nothing else there.'
          }
          onChange={setBaseUrl}
        />
      )}
      {kind === 'openai_compatible' && (
        <Check
          id="ai-reader-own-network"
          checked={ownNetwork}
          label="It is on my own network"
          note="Say so only for a server of your own, such as LM Studio or vLLM at home. It counts as on your own network only at a private address; otherwise it is a cloud service, and Sensitive papers are held back from it."
          onChange={setOwnNetwork}
        />
      )}
      <Field
        id="ai-reader-model"
        label="Model"
        value={model}
        placeholder={MODEL_EXAMPLES[kind]}
        autoCapitalize="off"
        autoCorrect="off"
        note={
          r
            ? 'As the reader has it. Find its models below to pick one.'
            : 'As the reader has it. Once saved, you can find the models it has.'
        }
        onChange={setModel}
      />
      {found && !found.problem && found.models.length > 0 && (
        <div className="field">
          <label htmlFor="ai-reader-pick">Models it has</label>
          <select
            id="ai-reader-pick"
            value={found.models.includes(model) ? model : ''}
            onChange={(e) => {
              if (e.target.value) setModel(e.target.value);
            }}
          >
            <option value="">Pick one…</option>
            {found.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}
      <Field
        id="ai-reader-key"
        label={anthropic ? 'API key' : 'API key (if it needs one)'}
        type="password"
        value={key}
        autoComplete="new-password"
        required={false}
        note={
          moved
            ? 'You changed the kind of reader or its address: the key saved is forgotten, and only ever sent where it was typed for. Type it again if this one needs it.'
            : r?.api_key === 'set'
              ? `One is saved, ending ${r.api_key_last4 ?? '…'}, and never shown. Leave this empty to keep it, or type a new one.`
              : anthropic
                ? 'From your Anthropic account. Sent to Anthropic alone, kept encrypted, and never shown again.'
                : 'Sent to the reader as Authorization: Bearer. It is kept encrypted, and never shown again.'
        }
        onChange={setKey}
      />
      {r?.api_key === 'set' && !moved && (
        <Check
          id="ai-reader-forget-key"
          checked={forgetKey}
          disabled={key !== ''}
          label="Forget the saved key"
          onChange={setForgetKey}
        />
      )}
      <Field
        id="ai-reader-timeout"
        label="Seconds one paper may take"
        value={timeout}
        inputMode="numeric"
        note={`From ${AI_READER_TIMEOUT_MIN} to ${AI_READER_TIMEOUT_MAX}. Slower, and the paper is read without it.`}
        onChange={setTimeoutSecs}
      />
      <Field
        id="ai-reader-cap"
        label="Most papers in a month"
        value={cap}
        inputMode="numeric"
        note={
          props.view.month
            ? `For a cloud service: past it, papers are read without it until next month, and the owners are emailed at 80%. So far: ${aiReaderMonthWords(props.view.month)}.`
            : 'For a cloud service: past it, papers are read without it until next month.'
        }
        onChange={setCap}
      />
      <ErrorNote message={error} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy}>
          Save
        </Button>
        {r && (
          <Button
            kind="quiet"
            disabled={busy || models.busy}
            describedBy="ai-reader-models-note"
            onClick={() => void models.run((tk) => api.aiReaderModels(tk))}
          >
            {models.busy ? 'Finding…' : 'Find its models'}
          </Button>
        )}
        {r && (
          <Button kind="quiet" danger disabled={busy} onClick={() => setAsking(true)}>
            Remove the AI reader
          </Button>
        )}
      </div>
      {r && (
        <p id="ai-reader-models-note" className="muted field-note">
          Asks the reader saved which models it has: their names, and nothing else.
        </p>
      )}
      <ErrorNote message={models.error} />
      <div role="status">
        {models.view?.state === 'late' && <p className="attention">{models.view.words}</p>}
        {found && <p className={found.problem ? 'attention' : 'muted'}>{found.words}</p>}
      </div>
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {asking && (
        <ConfirmDialog
          title="Remove the AI reader?"
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setAsking(false)}
        >
          The vault forgets the reader and its key. Papers are read by the vault’s rules alone until
          a reader is set up again.
        </ConfirmDialog>
      )}
    </form>
  );
}

/** Test: it must pass before any paper is sent to the reader. */
function AiReaderTest(props: { onTested: () => Promise<void> }) {
  const test = useWorkerCheck();
  const tested = useRef<HTMLDivElement>(null);
  const { onTested } = props;
  useEffect(() => {
    if (test.view?.state === 'done' || test.view?.state === 'late') {
      tested.current?.focus();
      if (test.view.state === 'done') void onTested();
    }
  }, [test.view, onTested]);
  const result = test.view?.state === 'done' ? (test.view.ai_reader ?? null) : null;
  return (
    <div className="stack">
      <div className="row">
        <Button
          kind="quiet"
          disabled={test.busy}
          describedBy="ai-reader-test-note"
          onClick={() => void test.run((t) => api.testAiReader(t))}
        >
          {test.busy ? 'Testing…' : 'Test the AI reader'}
        </Button>
      </div>
      <p id="ai-reader-test-note" className="muted field-note">
        Test sends the reader a one-line question of its own — none of your papers — and says how
        long it took to answer, and where it runs. What it answered is never shown.
      </p>
      <ErrorNote message={test.error} />
      <div ref={tested} tabIndex={-1} role="status" className="stack">
        {test.view?.state === 'late' && <p className="attention">{test.view.words}</p>}
        {result && (
          <p className={result.problem ? 'attention' : 'notice'}>
            <span aria-hidden="true">{result.problem ? '✗ ' : '✓ '}</span>
            {result.words}
            {!result.problem && result.runs_at
              ? ` It runs ${aiReaderRunsAtWords(result.runs_at)}.`
              : ''}
          </p>
        )}
      </div>
    </div>
  );
}
