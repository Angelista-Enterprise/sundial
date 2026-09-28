import { beforeEach, describe, expect, it, vi } from 'vitest';

const callChatCompletion = vi.fn();
vi.mock('./transport.js', () => ({ callChatCompletion: (...args: unknown[]) => callChatCompletion(...args) }));
vi.mock('./config.js', () => ({ getLlmConfig: () => ({ baseUrl: 'x', apiKey: null, model: 'qwen/qwen3.8-flash-next' }) }));

const { callSystemOneLocal, systemOneBackend } = await import('./systemone-local.js');

const questions = {
  is_work: { type: 'noul' as const, instructions: 'Working?' },
  subject: { type: 'choice' as const, instructions: 'Which?', criteria: { project: 'p', app: 'a' } },
  depth: { type: 'score' as const, instructions: 'How deep?', criteria: ['shallow', 'deep'] },
};

beforeEach(() => callChatCompletion.mockReset());

describe('callSystemOneLocal', () => {
  it('asks the text model for probabilities as JSON and maps them to Jev\'s answer shape', async () => {
    callChatCompletion.mockResolvedValueOnce({
      content: '```json\n{"answers":{"is_work":{"noul":0.8},"subject":{"probabilities":{"project":3,"app":1}},"depth":{"probabilities":{"0":0.2,"1":0.8}}}}\n```',
      statusCode: 200,
      promptTokens: 300,
      completionTokens: 40,
      totalTokens: 340,
      toolCalls: [],
      finishReason: 'stop',
    });
    const result = await callSystemOneLocal({ minutes: 31 }, questions);
    expect(result.model).toBe('qwen/qwen3.8-flash-next');
    expect(result.answers.is_work).toEqual({ type: 'noul', noul: 0.8 });
    expect(result.answers.subject).toEqual({ type: 'choice', choice: 'project', probabilities: { project: 0.75, app: 0.25 }, confidence: 0.75 });
    expect(result.answers.depth).toMatchObject({ type: 'score', score: 1, confidence: 0.8 });
    expect(result.inputTokens).toBe(300);
    const [messages, opts] = callChatCompletion.mock.calls[0];
    expect(opts.temperature).toBe(0);
    expect(messages[1].content).toContain('"minutes":31');
  });

  it('throws on prose instead of JSON so the executor can count it as a failure', async () => {
    callChatCompletion.mockResolvedValueOnce({ content: 'I think they were working.', statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2, toolCalls: [], finishReason: 'stop' });
    await expect(callSystemOneLocal({}, questions)).rejects.toThrow(/no JSON/);
  });
});

describe('systemOneBackend', () => {
  it('reads SUNDIAL_SYSTEMONE_BACKEND; without it, jev only when its key is set', () => {
    const before = { backend: process.env.SUNDIAL_SYSTEMONE_BACKEND, key: process.env.TYPESAFE_API_KEY };
    try {
      delete process.env.SUNDIAL_SYSTEMONE_BACKEND;
      delete process.env.TYPESAFE_API_KEY;
      expect(systemOneBackend()).toBe('local');
      process.env.TYPESAFE_API_KEY = 'k';
      expect(systemOneBackend()).toBe('jev');
      process.env.SUNDIAL_SYSTEMONE_BACKEND = 'local';
      expect(systemOneBackend()).toBe('local');
      process.env.SUNDIAL_SYSTEMONE_BACKEND = 'nonsense';
      expect(systemOneBackend()).toBe('jev');
    } finally {
      for (const [k, v] of [['SUNDIAL_SYSTEMONE_BACKEND', before.backend], ['TYPESAFE_API_KEY', before.key]] as [string, string | undefined][]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
