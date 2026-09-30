import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('getLlmConfig: which provider does what (llm.use)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-use-'));
  const saved = { ...process.env };
  beforeAll(() => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        llm: {
          providers: [{ id: 'far', baseUrl: 'https://llm.example.com/v1', model: 'big-model' }],
          use: { journal: 'far', intent: 'openai', extract: 'gone' },
        },
      }),
    );
    Object.assign(process.env, { SUNDIAL_HOME: home, SUNDIAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', SUNDIAL_LLM_MODEL: 'local-model', SUNDIAL_LLM_KEY_FAR: 'k-far' });
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sends a purpose to its provider, with that provider key, and the rest to the .env model', async () => {
    const { getLlmConfig } = await import('./config.js');
    expect(getLlmConfig('journal')).toEqual({ route: 'far', baseUrl: 'https://llm.example.com/v1', apiKey: 'k-far', model: 'big-model' });
    expect(getLlmConfig('intent')?.model).toBe('local-model');
    expect(getLlmConfig('reflect')?.route).toBe('openai');
    // A provider that was removed falls back to the .env model instead of stopping the call.
    expect(getLlmConfig('extract')?.route).toBe('openai');
  });

  it('W3: reads llm.use from its source (the kernel\'s state.config), so a change applies without a restart', async () => {
    const { getLlmConfig, setLlmConfigSource } = await import('./config.js');
    let llm = { providers: [{ id: 'far', label: 'Far', baseUrl: 'https://llm.example.com/v1', model: 'big-model' }], use: {} as Record<string, string> };
    setLlmConfigSource(() => llm);
    try {
      expect(getLlmConfig('reflect')?.route).toBe('openai');
      llm = { ...llm, use: { reflect: 'far' } };
      expect(getLlmConfig('reflect')?.model).toBe('big-model');
    } finally {
      setLlmConfigSource(null);
    }
    // And the file again, read per call rather than cached for the process.
    expect(getLlmConfig('journal')?.route).toBe('far');
  });
});
