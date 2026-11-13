import { describe, expect, it } from 'vitest';
import {
  AI_READER_DEFAULT_PORTS,
  aiReaderNameRefused,
  aiReaderPort,
  aiReaderUnprovenProblem,
  aiReaderAddress,
  aiReaderAddressAllowed,
  aiReaderModelsResult,
  aiReaderRunsAtByName,
  aiReaderRunsAtOf,
  AI_READER_KINDS_OFFERED,
  AI_READER_PATHS,
  OPENAI_BASE_URL,
  aiReaderCapWarnAt,
  aiReaderHostedAllows,
  aiReaderIdentity,
  aiReaderMonthWords,
  aiReaderProvider,
  aiReaderRunsAtSaid,
  aiReaderSendSensitiveWarning,
  mayReadWith,
  type AiReaderRunsAt,
} from './ai-reader.js';
import { isLinkLocalAddress } from './push.js';

/**
 * The guards on an address an owner types for the AI reader (0.9.0, AIR1;
 * plan-ai-readers, decisions 2 and 9).
 */
describe('the AI reader’s address (AIR1, decision 9)', () => {
  const self = { httpsOnly: false };
  const hosted = { httpsOnly: true };

  it('keeps http(s) and the address alone: scheme, host and port', () => {
    expect(aiReaderAddress(' http://192.168.1.30:11434 ', self)).toEqual({
      url: 'http://192.168.1.30:11434',
      host: '192.168.1.30:11434',
      hostname: '192.168.1.30',
    });
    expect(aiReaderAddress('https://ollama.example.com/', self)).toMatchObject({
      url: 'https://ollama.example.com',
    });
    expect(aiReaderAddress('http://[fd00::5]:11434', self)).toMatchObject({
      url: 'http://[fd00::5]:11434',
      hostname: 'fd00::5',
    });
  });

  it('refuses another scheme, a sign-in, a path, a query or a fragment', () => {
    const problem = (s: string, o = self) => {
      const got = aiReaderAddress(s, o);
      return 'problem' in got ? got.problem : null;
    };
    expect(problem('not a url')).toBe('not_url');
    expect(problem('ftp://ollama:11434')).toBe('scheme');
    expect(problem('file:///etc/passwd')).toBe('scheme');
    expect(problem('gopher://x:70')).toBe('scheme');
    expect(problem('http://user:pw@ollama:11434')).toBe('credentials');
    expect(problem('http://user@ollama:11434')).toBe('credentials');
    expect(problem('http://ollama:11434/api/chat')).toBe('path');
    expect(problem('http://router.lan/admin')).toBe('path');
    expect(problem('http://ollama:11434?x=1')).toBe('query');
    expect(problem('http://ollama:11434/?')).toBe('query');
    expect(problem('http://ollama:11434#a')).toBe('query');
    // The hosted edition: https alone.
    expect(problem('http://ollama.example.com', hosted)).toBe('https_needed');
    expect(problem('https://ollama.example.com', hosted)).toBeNull();
  });

  it('says where a reader runs: inside the network is your own, a public address is a cloud service (decision 2)', () => {
    expect(aiReaderRunsAtOf('192.168.1.30')).toBe('own_network');
    expect(aiReaderRunsAtOf('10.0.0.2')).toBe('own_network');
    expect(aiReaderRunsAtOf('127.0.0.1')).toBe('own_network');
    expect(aiReaderRunsAtOf('fd00::5')).toBe('own_network');
    expect(aiReaderRunsAtOf('100.64.1.2')).toBe('own_network');
    expect(aiReaderRunsAtOf('8.8.8.8')).toBe('cloud');
    expect(aiReaderRunsAtOf('2606:4700::1111')).toBe('cloud');
    // By name alone: this machine, .local, a name with no dot; else DNS says.
    expect(aiReaderRunsAtByName('localhost')).toBe('own_network');
    expect(aiReaderRunsAtByName('nas.local')).toBe('own_network');
    expect(aiReaderRunsAtByName('ollama')).toBe('own_network');
    expect(aiReaderRunsAtByName('192.168.1.30')).toBe('own_network');
    expect(aiReaderRunsAtByName('[::1]')).toBe('own_network');
    expect(aiReaderRunsAtByName('203.0.113.9')).toBe('cloud');
    expect(aiReaderRunsAtByName('ollama.example.com')).toBeNull();
  });

  it('never sends to link-local, "this network" or multicast; on the hosted edition, nowhere inside a network', () => {
    for (const a of [
      '169.254.169.254',
      'fe80::1',
      '0.0.0.0',
      '::',
      '224.0.0.1',
      'ff02::1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      'not-an-address',
    ]) {
      expect(isLinkLocalAddress(a), a).toBe(true);
      expect(aiReaderAddressAllowed(a, { publicOnly: false }), a).toBe(false);
    }
    expect(aiReaderAddressAllowed('192.168.1.30', { publicOnly: false })).toBe(true);
    expect(aiReaderAddressAllowed('127.0.0.1', { publicOnly: false })).toBe(true);
    expect(aiReaderAddressAllowed('192.168.1.30', { publicOnly: true })).toBe(false);
    expect(aiReaderAddressAllowed('127.0.0.1', { publicOnly: true })).toBe(false);
    expect(aiReaderAddressAllowed('::ffff:10.0.0.1', { publicOnly: true })).toBe(false);
    expect(aiReaderAddressAllowed('8.8.8.8', { publicOnly: true })).toBe(true);
  });

  it('refuses link-local however an IPv4 address is wrapped in IPv6, and the clouds’ metadata addresses (the review, M2)', () => {
    for (const a of [
      '::a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '2002:a9fe:a9fe::',
      '::ffff:0:a9fe:a9fe',
      'fd00:ec2::254',
      '100.100.100.200',
    ]) {
      expect(isLinkLocalAddress(a), a).toBe(true);
      expect(aiReaderAddressAllowed(a, { publicOnly: false }), a).toBe(false);
    }
    // Loopback, and an ordinary private or public address, are not.
    for (const a of ['::1', '127.0.0.1', '192.168.1.30', 'fd00::5', '100.100.100.201', '8.8.8.8']) {
      expect(isLinkLocalAddress(a), a).toBe(false);
    }
  });

  it('the vault’s own services by name, the allowed ports, and the shortest and longest address (S2, M3)', () => {
    for (const n of ['api', 'postgres', 'web', 'worker', 'fdv-api-1', 'fdv_postgres_1', 'API.']) {
      expect(aiReaderNameRefused(n), n).toBe(true);
      expect(aiReaderAddress(`http://${n}:11434`, self)).toEqual({ problem: 'own' });
    }
    for (const n of ['ollama', 'apiserver', 'my-api', 'host.docker.internal', 'localhost']) {
      expect(aiReaderNameRefused(n), n).toBe(false);
    }
    expect(AI_READER_DEFAULT_PORTS).toEqual([11434, 1234, 8000, 8080, 80, 443]);
    expect(aiReaderPort('http://ollama:11434')).toBe(11434);
    expect(aiReaderPort('http://ollama')).toBe(80);
    expect(aiReaderPort('https://[fd00::5]')).toBe(443);
    expect(aiReaderPort('https://[fd00::5]:8000')).toBe(8000);
    // 8 characters, which the database keeps; and over 300, said rather than refused there.
    expect(aiReaderAddress('http://a', self)).toMatchObject({ url: 'http://a' });
    expect(aiReaderAddress(`http://${'a'.repeat(300)}.example`, self)).toEqual({
      problem: 'too_long',
    });
  });

  it('an address no Test has passed at has two outcomes alone (S2b)', () => {
    const two = [
      'unreachable',
      'timeout',
      'refused',
      'http_error',
      'too_big',
      'bad_reply',
      'no_model',
    ].map((p) => aiReaderUnprovenProblem(p as never));
    expect(new Set(two)).toEqual(new Set(['unreachable', 'bad_reply']));
  });

  it('calls only the reader’s own paths; reads with all three kinds since AIR3', () => {
    expect(AI_READER_PATHS.ollama).toEqual(['/api/chat', '/api/tags']);
    expect(AI_READER_PATHS.openai_compatible).toEqual(['/v1/chat/completions', '/v1/models']);
    // Anthropic's list of models: AIR3's addition to decision 9.
    expect(AI_READER_PATHS.anthropic).toEqual(['/v1/messages', '/v1/models']);
    expect(AI_READER_KINDS_OFFERED).toEqual(['ollama', 'anthropic', 'openai_compatible']);
  });

  it('says the list of models in the vault’s own words', () => {
    expect(aiReaderModelsResult({ problem: null, models: ['a', 'b'] }).words).toBe(
      'It has 2 models.',
    );
    expect(aiReaderModelsResult({ problem: 'bad_reply', models: [] }).words).toMatch(
      /not as that kind of reader does/,
    );
  });
});

/**
 * The sending rule (AIR3, decisions 4 and 6), its whole table: where the
 * reader runs × Only me × the paper's own Sensitive and its kind's default ×
 * "Also send sensitive papers".
 */
describe('mayReadWith: who may be sent to a reader (AIR3)', () => {
  const where: Array<AiReaderRunsAt | null> = ['own_network', 'cloud', null];
  const visibilities = ['household', 'adults', 'private', null] as const;
  const owns = [true, false, null] as const;
  const kinds: Array<{ sensitive_default: boolean; default_visibility?: string } | null> = [
    { sensitive_default: true, default_visibility: 'household' },
    { sensitive_default: false, default_visibility: 'household' },
    { sensitive_default: false, default_visibility: 'private' },
    // A kind whose default visibility the caller did not say.
    { sensitive_default: false },
    null,
  ];

  it('the full table', () => {
    for (const runs_at of where) {
      for (const visibility of visibilities) {
        for (const sensitive of owns) {
          for (const kind of kinds) {
            for (const send_sensitive of [false, true]) {
              const got = mayReadWith({ visibility, sensitive, kind }, { runs_at, send_sensitive });
              const label = JSON.stringify({
                runs_at,
                visibility,
                sensitive,
                kind,
                send_sensitive,
              });
              // On the household's own network: always.
              if (runs_at === 'own_network') {
                expect(got, label).toEqual({ may: true });
                continue;
              }
              // A cloud reader (or one not known): Only me never, the switch whatever —
              // its own visibility, else its kind's default.
              const seen = visibility ?? kind?.default_visibility ?? null;
              if (seen === 'private') {
                expect(got, label).toEqual({ may: false, why: 'only_me' });
                continue;
              }
              // Sensitive: its own word, else its kind's, else (a kind not known) yes.
              const isSensitive = sensitive ?? (kind ? kind.sensitive_default : true);
              if (isSensitive && !send_sensitive) {
                expect(got, label).toEqual({ may: false, why: 'sensitive' });
                continue;
              }
              // Who may open it not known at all: as if Only me (the review, D1).
              expect(got, label).toEqual(
                seen === null ? { may: false, why: 'only_me' } : { may: true },
              );
            }
          }
        }
      }
    }
  });

  it('a batch’s item with no visibility of its own takes its kind’s default: Only me kinds are never sent', () => {
    const paper = {
      visibility: null,
      sensitive: false,
      kind: { sensitive_default: false, default_visibility: 'private' },
    };
    expect(mayReadWith(paper, { runs_at: 'cloud', send_sensitive: true })).toEqual({
      may: false,
      why: 'only_me',
    });
    expect(
      mayReadWith(
        { ...paper, visibility: 'household' },
        { runs_at: 'cloud', send_sensitive: false },
      ),
    ).toEqual({ may: true });
  });

  it('a kind’s default changed changes the answer for every paper left as its kind says', () => {
    const left = { visibility: 'household', sensitive: null };
    const reader = { runs_at: 'cloud' as const, send_sensitive: false };
    expect(mayReadWith({ ...left, kind: { sensitive_default: false } }, reader).may).toBe(true);
    expect(mayReadWith({ ...left, kind: { sensitive_default: true } }, reader).may).toBe(false);
    // One set to no keeps it.
    expect(
      mayReadWith({ ...left, sensitive: false, kind: { sensitive_default: true } }, reader).may,
    ).toBe(true);
  });
});

describe('where a reader runs, the hosted providers and the month (AIR3)', () => {
  it('Anthropic is a cloud service; OpenAI-compatible only on the owner’s word and a private address', () => {
    expect(aiReaderRunsAtSaid('anthropic', 'own_network', true)).toBe('cloud');
    expect(aiReaderRunsAtSaid('openai_compatible', 'own_network', false)).toBe('cloud');
    expect(aiReaderRunsAtSaid('openai_compatible', 'cloud', true)).toBe('cloud');
    expect(aiReaderRunsAtSaid('openai_compatible', 'own_network', true)).toBe('own_network');
    expect(aiReaderRunsAtSaid('ollama', 'own_network', false)).toBe('own_network');
    expect(aiReaderRunsAtSaid('ollama', 'cloud', true)).toBe('cloud');
  });

  it('the hosted edition: Anthropic, and OpenAI-compatible only at OpenAI’s own address', () => {
    expect(aiReaderHostedAllows('anthropic', null)).toBe(true);
    expect(aiReaderHostedAllows('openai_compatible', OPENAI_BASE_URL)).toBe(true);
    expect(aiReaderHostedAllows('openai_compatible', 'https://llm.example.com')).toBe(false);
    expect(aiReaderHostedAllows('openai_compatible', null)).toBe(false);
  });

  it('names the reader the switch was approved for: a saved one by kind and address, .env’s by kind and host (the review, S3)', () => {
    expect(aiReaderIdentity('settings', 'anthropic', null)).toBe(
      'settings:anthropic:https://api.anthropic.com',
    );
    expect(aiReaderIdentity('settings', 'openai_compatible', OPENAI_BASE_URL)).toBe(
      'settings:openai_compatible:https://api.openai.com',
    );
    expect(aiReaderIdentity('env', 'ollama', 'ai.example.com:11434')).toBe(
      'env:ollama:ai.example.com:11434',
    );
    // Another provider, or .env taking over, is another reader.
    expect(aiReaderIdentity('settings', 'openai_compatible', 'https://llm.example.com')).not.toBe(
      aiReaderIdentity('settings', 'openai_compatible', OPENAI_BASE_URL),
    );
  });

  it('a batch’s item that names neither its visibility nor its kind is held as Only me, the switch on (the review, D1)', () => {
    const unknown = { visibility: null, sensitive: true, kind: null };
    expect(mayReadWith(unknown, { runs_at: 'cloud', send_sensitive: false })).toEqual({
      may: false,
      why: 'sensitive',
    });
    expect(mayReadWith(unknown, { runs_at: 'cloud', send_sensitive: true })).toEqual({
      may: false,
      why: 'only_me',
    });
    expect(mayReadWith(unknown, { runs_at: 'own_network', send_sensitive: false })).toEqual({
      may: true,
    });
  });

  it('the 80% mark, and the count in words', () => {
    expect(aiReaderCapWarnAt(500)).toBe(400);
    expect(aiReaderCapWarnAt(1)).toBe(1);
    expect(aiReaderCapWarnAt(3)).toBe(3);
    expect(aiReaderMonthWords({ sent: 120, cap: 500 })).toBe('120 of 500 this month');
  });

  it('the warning names the provider, says words only, and links its terms', () => {
    const w = aiReaderSendSensitiveWarning('anthropic', null);
    expect(w).toMatch(/sent to Anthropic/);
    expect(w).toMatch(/the words the vault read from the page/);
    expect(w).toMatch(/Never the page itself, nor the file/);
    expect(w).toMatch(/Only me papers are never sent/);
    expect(aiReaderProvider('anthropic', null).terms).toMatch(/^https:\/\/www\.anthropic\.com\//);
    expect(aiReaderProvider('openai_compatible', OPENAI_BASE_URL).name).toBe('OpenAI');
    expect(aiReaderProvider('openai_compatible', 'http://192.168.1.9:1234')).toEqual({
      name: 'whoever runs 192.168.1.9:1234',
      terms: null,
    });
  });
});
