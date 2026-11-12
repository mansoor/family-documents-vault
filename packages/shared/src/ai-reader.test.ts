import { describe, expect, it } from 'vitest';
import {
  aiReaderAddress,
  aiReaderAddressAllowed,
  aiReaderModelsResult,
  aiReaderRunsAtByName,
  aiReaderRunsAtOf,
  AI_READER_KINDS_OFFERED,
  AI_READER_PATHS,
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

  it('calls only the reader’s own paths; reads with Ollama alone until AIR3', () => {
    expect(AI_READER_PATHS.ollama).toEqual(['/api/chat', '/api/tags']);
    expect(AI_READER_KINDS_OFFERED).toEqual(['ollama']);
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
