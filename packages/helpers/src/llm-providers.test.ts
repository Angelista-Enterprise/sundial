import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatDefault, isLocalUrl, ledgerModel, parseProviders, providerKeyEnv, providerLabel, setEnvValues } from './llm-providers.js';

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
      { id: 'groq', baseUrl: 'https://dup.example/v1', model: 'm' },
      { id: 'bad', baseUrl: 'ftp://x', model: 'm' },
      { id: 'creds', baseUrl: 'https://u:p@x.example/v1', model: 'm' },
      { id: 'nomodel', baseUrl: 'https://x.example/v1', model: ' ' },
    ]);
    expect(list).toEqual([{ id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama', label: 'Groq' }]);
    expect(parseProviders(undefined)).toEqual([]);
    expect(providerKeyEnv('open-router')).toBe('SUNDIAL_LLM_KEY_OPEN_ROUTER');
    expect(providerKeyEnv('openai')).toBe('SUNDIAL_LLM_API_KEY');
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
    const llm = { providers: [{ id: 'p-puzzlebox', label: 'Puzzlebox', baseUrl: 'https://llm.example.org/v1', model: 'puzzle-7b' }], use: { default: 'p-puzzlebox' } };
    const dsh = { provider: 'openai', model: 'qwen/qwen3.8-flash-next' };
    expect(chatDefault(dsh, llm, false)).toEqual({ provider: 'p-puzzlebox', model: 'puzzle-7b' });
    expect(chatDefault({ provider: 'tensorx', model: 'm' }, llm, false)).toEqual({ provider: 'p-puzzlebox', model: 'puzzle-7b' });
    // Gnomon's own route in .env, a picked route, or no usable default: the selection stays.
    expect(chatDefault(dsh, llm, true)).toBe(dsh);
    const picked = { provider: 'p-other', model: 'x' };
    expect(chatDefault(picked, llm, false)).toBe(picked);
    expect(chatDefault(dsh, { ...llm, use: {} }, false)).toBe(dsh);
    expect(chatDefault(dsh, undefined, false)).toBe(dsh);
  });
});
