import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatCandidates, chatDefault, isLocalUrl, openChatSource, pausedCandidates, routeHeldIn, ledgerModel, parseProviders, piAiProfiles, providerKeyEnv, providerLabel, setEnvValues } from './llm-providers.js';

describe('llm providers', () => {
  it('names a provider the way a person would', () => {
    expect(providerLabel('https://api.openai.com/v1')).toBe('OpenAI');
    expect(providerLabel('https://openrouter.ai/api/v1')).toBe('OpenRouter');
    expect(providerLabel('http://127.0.0.1:11434/v1')).toBe('Ollama on this Mac');
    expect(providerLabel('https://llm.example.org/v1')).toBe('llm.example.org');
    expect(isLocalUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false);
  });

  it('records a bare hosted model id under its route, so the Ledger prices it as remote', () => {
    expect(ledgerModel('gpt-5', 'openai', 'https://api.openai.com/v1')).toBe('openai/gpt-5');
    expect(ledgerModel('deepseek-chat', 'deepseek', 'https://api.deepseek.com/v1')).toBe('deepseek/deepseek-chat');
    // Already namespaced, on this Mac, or an address nobody knows: unchanged.
    expect(ledgerModel('qwen/qwen3.8-flash-next', 'openai', 'https://api.tensorx.ai/v1')).toBe('qwen/qwen3.8-flash-next');
    expect(ledgerModel('qwen3.8:27b-mlx', 'openai', 'http://127.0.0.1:11434/v1')).toBe('qwen3.8:27b-mlx');
    expect(ledgerModel('gpt-5', 'groq', undefined)).toBe('gpt-5');
  });

  it('keeps well-formed providers only, and never lets one take the default route', () => {
    const list = parseProviders([
      { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1/', model: 'llama' },
      { id: 'openai', baseUrl: 'https://x.example/v1', model: 'm' },
      { id: 'tensorx', baseUrl: 'https://x.example/v1', model: 'm' },
      { id: 'claude', baseUrl: 'https://x.example/v1', model: 'm' },
      { id: 'copilot', baseUrl: 'https://x.example/v1', model: 'm' },
      { id: 'groq', baseUrl: 'https://dup.example/v1', model: 'm' },
      { id: 'bad', baseUrl: 'ftp://x', model: 'm' },
      { id: 'creds', baseUrl: 'https://u:p@x.example/v1', model: 'm' },
      { id: 'nomodel', baseUrl: 'https://x.example/v1', model: ' ' },
    ]);
    expect(list).toEqual([{ id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama', label: 'Groq', protocol: 'openai-chat' }]);
    expect(parseProviders(undefined)).toEqual([]);
    // The protocol: one of three, else OpenAI chat completions.
    const spoken = parseProviders([
      { id: 'anthropic-api', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', protocol: 'anthropic-messages' },
      { id: 'odd', baseUrl: 'https://x.example/v1', model: 'm', protocol: 'carrier-pigeon' },
    ]);
    expect(spoken.map((p) => p.protocol)).toEqual(['anthropic-messages', 'openai-chat']);
    // pi-ai profiles: hand-declared, keyed by the same .env name, only for what Sundial's adapter does not speak.
    expect(piAiProfiles(spoken)).toEqual({ 'anthropic-api': { displayName: 'Anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', apiKeyEnv: 'SUNDIAL_LLM_KEY_ANTHROPIC_API', models: [{ id: 'claude-sonnet-4-5' }] } });
    expect(providerKeyEnv('open-router')).toBe('SUNDIAL_LLM_KEY_OPEN_ROUTER');
    expect(providerKeyEnv('openai')).toBe('SUNDIAL_LLM_API_KEY');
  });

  it('keeps hedgeTo and body, drops a malformed one and the protected body fields', () => {
    const [ok, bad] = parseProviders([
      { id: 'router', baseUrl: 'https://x.example/v1', model: 'm', hedgeTo: 'backup:vendor/m-1', body: { provider: { sort: 'latency' }, model: 'x', messages: [], tools: [], stream: false } },
      { id: 'other', baseUrl: 'https://x.example/v1', model: 'm', hedgeTo: 'Not A Route', body: ['nope'] },
    ]);
    expect(ok).toMatchObject({ hedgeTo: 'backup:vendor/m-1', body: { provider: { sort: 'latency' } } });
    expect(Object.keys(ok.body!)).toEqual(['provider']);
    expect(bad).not.toHaveProperty('hedgeTo');
    expect(bad).not.toHaveProperty('body');
  });

  it('sets and clears env lines, keeps the rest, and writes 0600', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'sundial-env-')), '.env');
    writeFileSync(file, '# keep me\nSUNDIAL_LLM_MODEL=old\nOTHER=1\nexport SUNDIAL_LLM_API_KEY=k\n');
    setEnvValues(file, { SUNDIAL_LLM_MODEL: 'new', SUNDIAL_LLM_API_KEY: '', SUNDIAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1' });
    expect(readFileSync(file, 'utf8')).toBe('# keep me\nSUNDIAL_LLM_MODEL=new\nOTHER=1\nSUNDIAL_LLM_BASE_URL=http://127.0.0.1:11434/v1\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => setEnvValues(file, { SUNDIAL_LLM_MODEL: 'a\nEVIL=1' })).toThrow();
    expect(() => setEnvValues(file, { 'bad key': 'x' })).toThrow();
  });

  it('a provider-only install chats on the provider llm.use.default names, with its model', () => {
    const llm = { providers: [{ id: 'p-puzzlebox', label: 'Puzzlebox', baseUrl: 'https://llm.example.org/v1', model: 'puzzle-7b', protocol: 'openai-chat' as const }], use: { default: 'p-puzzlebox' } };
    const dsh = { provider: 'openai', model: 'qwen/qwen3.8-flash-next' };
    expect(chatDefault(dsh, llm, false)).toEqual({ provider: 'p-puzzlebox', model: 'puzzle-7b' });
    expect(chatDefault({ provider: 'tensorx', model: 'm' }, llm, false)).toEqual({ provider: 'p-puzzlebox', model: 'puzzle-7b' });
    // Gnomon's own route in .env, a picked route, or no usable default: the selection stays.
    expect(chatDefault(dsh, llm, true)).toBe(dsh);
    // roles.chat (step 3): the first listed source is the default, whatever dsh saved; unknown sources are skipped.
    expect(chatDefault(dsh, { ...llm, roles: { chat: ['gone', 'p-puzzlebox:puzzle-9b', 'p-puzzlebox'] } }, true)).toEqual({ provider: 'p-puzzlebox', model: 'puzzle-9b' });
    expect(chatCandidates({ ...llm, roles: { chat: ['p-puzzlebox', 'gone'] } })).toEqual([{ provider: 'p-puzzlebox', model: 'puzzle-7b' }]);
    // A held source: the thread continues on the next open one; nothing to do when it is fine or nothing else is open.
    const list = [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }, { provider: 'c', model: 'z' }];
    const held = (route: string) => route === 'a' || route === 'b';
    expect(openChatSource({ provider: 'a', model: 'x' }, list, held)).toEqual({ provider: 'c', model: 'z' });
    expect(openChatSource({ provider: 'c', model: 'z' }, list, held)).toBeNull();
    expect(openChatSource({ provider: 'a', model: 'x' }, list, () => true)).toBeNull();
    // Set 2 R4: a held route's own hedgeTo comes before roles.chat, with its model or the backup's own.
    const two = { providers: [{ ...llm.providers[0], id: 'main', hedgeTo: 'backup' }, { ...llm.providers[0], id: 'backup', model: 'slow' }], roles: { chat: ['main'] } };
    expect(pausedCandidates(two, 'main')).toEqual([{ provider: 'backup', model: 'slow' }, { provider: 'main', model: 'puzzle-7b' }]);
    expect(pausedCandidates({ ...two, providers: [{ ...two.providers[0], hedgeTo: 'backup:fast-9b' }, two.providers[1]] }, 'main')[0]).toEqual({ provider: 'backup', model: 'fast-9b' });
    expect(pausedCandidates(two, 'backup')).toEqual([{ provider: 'main', model: 'puzzle-7b' }]);
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(routeHeldIn({ a: { openUntil: soon }, b: { cooldownUntil: '2020-01-01T00:00:00.000Z' } }, 'a')).toBe(true);
    expect(routeHeldIn({ a: { openUntil: soon }, b: { cooldownUntil: '2020-01-01T00:00:00.000Z' } }, 'b')).toBe(false);
    expect(routeHeldIn(undefined, 'a')).toBe(false);
    const picked = { provider: 'p-other', model: 'x' };
    expect(chatDefault(picked, llm, false)).toBe(picked);
    expect(chatDefault(dsh, { ...llm, use: {} }, false)).toBe(dsh);
    expect(chatDefault(dsh, undefined, false)).toBe(dsh);
  });
});
