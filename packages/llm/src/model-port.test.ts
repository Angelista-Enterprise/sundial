import { afterEach, describe, expect, it } from 'vitest';
import { setLlmConfigSource } from './config.js';
import { getModelPort, setModelPort, type ModelPortRequest } from './model-port.js';
import { callChatCompletion } from './transport.js';

const llm = (protocol: 'openai-chat' | 'anthropic-messages') => ({
  providers: [{ id: 'far', label: 'Far', baseUrl: 'https://llm.example.com/v1', model: 'big-model', protocol }],
  use: { intent: 'far' },
  sources: {},
  roles: {},
});
afterEach(() => {
  setLlmConfigSource(null);
  setModelPort(null);
});

describe('the model port', () => {
  it('answers a purpose whose provider speaks a protocol the raw fetch does not, with the route and model', async () => {
    const asked: ModelPortRequest[] = [];
    setModelPort({ complete: async (request) => (asked.push(request), { content: 'ok', statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2, toolCalls: [], finishReason: 'stop' }) });
    setLlmConfigSource(() => llm('anthropic-messages'));
    const out = await callChatCompletion([{ role: 'user', content: 'q' }], { purpose: 'intent', maxTokens: 9 });
    expect(out.content).toBe('ok');
    expect(asked).toEqual([{ route: 'far', model: 'big-model', messages: [{ role: 'user', content: 'q' }], tools: undefined, maxTokens: 9, temperature: undefined, timeoutMs: undefined }]);
  });

  it('says plainly when no port is set, and leaves an openai-chat provider to the raw fetch', async () => {
    setLlmConfigSource(() => llm('anthropic-messages'));
    await expect(callChatCompletion([{ role: 'user', content: 'q' }], { purpose: 'intent' })).rejects.toThrow(/speaks anthropic-messages.*no model port/);
    expect(getModelPort()).toBeNull();
    setModelPort({ complete: async () => { throw new Error('the port must not answer this'); } });
    setLlmConfigSource(() => llm('openai-chat'));
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'raw' }, finish_reason: 'stop' }] }), { status: 200 })) as typeof fetch;
      expect((await callChatCompletion([{ role: 'user', content: 'q' }], { purpose: 'intent' })).content).toBe('raw');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
