import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLocalUrl, parseProviders, providerKeyEnv, providerLabel, setEnvValues } from './llm-providers.js';

describe('llm providers', () => {
  it('names a provider the way a person would', () => {
    expect(providerLabel('https://api.openai.com/v1')).toBe('OpenAI');
    expect(providerLabel('https://openrouter.ai/api/v1')).toBe('OpenRouter');
    expect(providerLabel('http://127.0.0.1:11434/v1')).toBe('Ollama on this Mac');
    expect(providerLabel('https://llm.example.org/v1')).toBe('llm.example.org');
    expect(isLocalUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false);
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
});
