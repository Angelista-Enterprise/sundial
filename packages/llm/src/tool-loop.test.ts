import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAuditedLlmCall = vi.fn();
vi.mock('./audited-call.js', () => ({ runAuditedLlmCall: (...args: unknown[]) => runAuditedLlmCall(...args) }));

const { BudgetExhaustedError, runToolLoop } = await import('./tool-loop.js');
import type { ToolDefinition } from './types.js';

const TOOLS: ToolDefinition[] = [
  { name: 'get_files', description: 'files', parameters: { type: 'object', properties: {} } },
  { name: 'get_commits', description: 'commits', parameters: { type: 'object', properties: {} } },
];

let auditCounter = 0;

/** One endpoint reply. `calls` empty means the model answered in prose and the loop should stop. */
function reply(content: string, calls: Array<{ name: string; arguments?: string }> = []) {
  auditCounter += 1;
  return {
    auditId: `audit-${auditCounter}`,
    content,
    finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
    toolCalls: calls.map((call, index) => ({ id: `call-${auditCounter}-${index}`, name: call.name, arguments: call.arguments ?? '{}' })),
  };
}

function baseOptions(overrides: Partial<Parameters<typeof runToolLoop>[0]> = {}) {
  return {
    purpose: 'ask' as const,
    messages: [{ role: 'user' as const, content: 'which files did I edit?' }],
    tools: TOOLS,
    execute: vi.fn(async () => ({ files: ['a.ts'] })),
    ...overrides,
  };
}

beforeEach(() => {
  runAuditedLlmCall.mockReset();
  auditCounter = 0;
});

describe('runToolLoop', () => {
  it('returns immediately when the model answers without calling a tool', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('you edited a.ts'));

    const result = await runToolLoop(baseOptions());

    expect(result.content).toBe('you edited a.ts');
    expect(result.stopReason).toBe('answered');
    expect(result.rounds).toHaveLength(1);
    expect(result.toolsUsed).toEqual([]);
    expect(runAuditedLlmCall).toHaveBeenCalledTimes(1);
  });

  it('executes a tool, feeds the result back, and answers on the next round', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }])).mockResolvedValueOnce(reply('you edited a.ts'));
    const options = baseOptions();

    const result = await runToolLoop(options);

    expect(result.content).toBe('you edited a.ts');
    expect(result.toolsUsed).toEqual(['get_files']);
    expect(result.rounds).toHaveLength(2);
    expect(options.execute).toHaveBeenCalledWith('get_files', {});

    // The second request must carry the assistant's tool-call turn AND a `tool`
    // message keyed to its id, or the endpoint cannot pair them.
    const secondCallMessages = runAuditedLlmCall.mock.calls[1][0].messages;
    expect(secondCallMessages.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [expect.objectContaining({ name: 'get_files' })] });
    expect(secondCallMessages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call-1-0' });
  });

  it('tells the model which tools exist when it names one that does not', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_weather' }])).mockResolvedValueOnce(reply('I cannot check the weather'));
    const options = baseOptions();

    const result = await runToolLoop(options);

    expect(options.execute).not.toHaveBeenCalled();
    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content);
    expect(toolMessage.error).toContain('no such tool');
    expect(toolMessage.availableTools).toEqual(['get_files', 'get_commits']);
    expect(result.rounds[0].calls[0]).toMatchObject({ ok: false });
    expect(result.toolsUsed).toEqual([]);
  });

  it('reports malformed arguments back to the model instead of throwing', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{not json' }])).mockResolvedValueOnce(reply('recovered'));
    const options = baseOptions();

    const result = await runToolLoop(options);

    expect(options.execute).not.toHaveBeenCalled();
    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content);
    expect(toolMessage.error).toBe('arguments were not valid JSON');
    expect(toolMessage.received).toBe('{not json');
    expect(result.content).toBe('recovered');
  });

  it('hands a handler failure to the model as a result, verbatim', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }])).mockResolvedValueOnce(reply('sorry, that failed'));
    const options = baseOptions({
      execute: vi.fn(async () => {
        throw new Error('invalid arguments for get_files: date: expected string');
      }),
    });

    const result = await runToolLoop(options);

    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content);
    expect(toolMessage.error).toBe('invalid arguments for get_files: date: expected string');
    expect(result.rounds[0].calls[0].error).toContain('expected string');
    // A failed call is not a tool that produced anything, so it is not "used".
    expect(result.toolsUsed).toEqual([]);
  });

  it('breaks a stall by naming the repeat rather than returning the same result twice', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"date":"2026-08-01"}' }]))
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"date":"2026-08-01"}' }]))
      .mockResolvedValueOnce(reply('fine, you edited a.ts'));
    const options = baseOptions();

    const result = await runToolLoop(options);

    expect(options.execute).toHaveBeenCalledTimes(1);
    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[2][0].messages.at(-1).content);
    expect(toolMessage.error).toContain('you already called get_files with these exact arguments');
    expect(result.content).toBe('fine, you edited a.ts');
  });

  it('re-runs the same tool when the arguments differ', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"date":"2026-08-01"}' }]))
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"date":"2026-07-31"}' }]))
      .mockResolvedValueOnce(reply('two days of files'));
    const options = baseOptions();

    await runToolLoop(options);

    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it('truncates an oversize array result loudly, saying how much was dropped', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }])).mockResolvedValueOnce(reply('done'));
    const rows = Array.from({ length: 400 }, (_, index) => ({ file: `file-${index}.ts`, symbols: ['aLongSymbolNameHere', 'another'] }));
    const options = baseOptions({ execute: vi.fn(async () => rows), maxResultBytes: 1_000 });

    await runToolLoop(options);

    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content);
    expect(toolMessage.truncated).toBe(true);
    expect(toolMessage.note).toMatch(/showing \d+ of 400 rows/);
    expect(toolMessage.rows.length).toBeLessThan(400);
  });

  it('marks a non-array oversize result as truncated rather than cutting the JSON mid-structure', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }])).mockResolvedValueOnce(reply('done'));
    const options = baseOptions({ execute: vi.fn(async () => ({ blob: 'x'.repeat(5_000) })), maxResultBytes: 500 });

    await runToolLoop(options);

    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content);
    expect(toolMessage.truncated).toBe(true);
    expect(toolMessage.note).toContain('over the 500-byte limit');
  });

  it('forces a prose answer when the round cap is reached, never surfacing "I ran out of steps"', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"n":1}' }]))
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"n":2}' }]))
      .mockResolvedValueOnce(reply('best answer from what I have'));
    const options = baseOptions({ maxRounds: 2 });

    const result = await runToolLoop(options);

    expect(result.stopReason).toBe('max-rounds');
    expect(result.content).toBe('best answer from what I have');
  });

  /**
   * Sending the schemas while forbidding their use left a model that had just
   * spent five rounds calling tools still primed to call one — and deepseek
   * responded by writing the call out in its own syntax as ordinary content,
   * which reached the owner as their answer. Withholding the schemas is the fix.
   */
  it('offers no tools at all on the forced final turn, and says so in the conversation', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"n":1}' }]))
      .mockResolvedValueOnce(reply('answered under duress'));

    await runToolLoop(baseOptions({ maxRounds: 1 }));

    const forced = runAuditedLlmCall.mock.calls[1][0];
    expect(forced.tools).toBeUndefined();
    expect(forced.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Do not request any more tools') });
  });

  /**
   * Telling a JSON caller to "answer in prose" at the end of its loop manufactures
   * the exact reply its parser rejects. The closing instruction has to know which
   * kind of caller it is closing for.
   */
  it('closes a structured run by asking for the format, not for prose', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files' }]))
      .mockResolvedValueOnce(reply('{"tldr":"ok"}'));

    await runToolLoop(baseOptions({ maxRounds: 1, validate: (c: string) => c.trim().startsWith('{') }));

    const closing = runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content;
    expect(closing).toContain('response format');
    expect(closing).not.toContain('in prose');
  });

  /**
   * The net under that fix. This is the literal string that reached the owner:
   * deepseek's internal tool-call markup, emitted as prose.
   */
  it('cuts leaked tool-call markup out of an answer rather than showing it', async () => {
    const leaked = 'Now let me get the full detail on the key moments. <｜DSML｜tool_calls> <｜DSML｜invoke name="gnomon_moment_detail">';
    runAuditedLlmCall.mockResolvedValueOnce(reply(leaked));

    const result = await runToolLoop(baseOptions());

    expect(result.content).toBe('Now let me get the full detail on the key moments.');
    expect(result.content).not.toContain('DSML');
  });

  it('handles the other common markup dialects too', async () => {
    for (const marker of ['<tool_call>{"name":"x"}', '<function_calls><invoke name="x">', '<|tool_calls|>']) {
      runAuditedLlmCall.mockReset();
      runAuditedLlmCall.mockResolvedValueOnce(reply(`Real prose here. ${marker}`));
      const result = await runToolLoop(baseOptions());
      expect(result.content).toBe('Real prose here.');
    }
  });

  it('leaves an ordinary answer untouched', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('You edited `claims.ts` 19 times. No markup here — 3 < 5 and a|b.'));

    const result = await runToolLoop(baseOptions());

    expect(result.content).toBe('You edited `claims.ts` 19 times. No markup here — 3 < 5 and a|b.');
  });

  it('checks the budget on every round trip, not once per question', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files' }]))
      .mockResolvedValueOnce(reply('', [{ name: 'get_commits' }]))
      .mockResolvedValueOnce(reply('answered'));
    const beforeCall = vi.fn(async () => {});

    await runToolLoop(baseOptions({ beforeCall }));

    expect(beforeCall).toHaveBeenCalledTimes(3);
    expect(beforeCall).toHaveBeenNthCalledWith(1, 1);
    expect(beforeCall).toHaveBeenNthCalledWith(3, 3);
  });

  it('answers from what it gathered when the budget runs out mid-run', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }])).mockResolvedValueOnce(reply('partial but useful'));
    const beforeCall = vi.fn(async (round: number, options?: { overCap?: boolean }) => {
      if (round > 1 && !options?.overCap) throw new BudgetExhaustedError();
      return `call-${round}${options?.overCap ? '-final' : ''}`;
    });

    const result = await runToolLoop(baseOptions({ beforeCall }));

    expect(result.stopReason).toBe('budget');
    expect(result.content).toBe('partial but useful');
    // W5: the forced answer is reserved too (past the cap), and its row takes that id.
    expect(beforeCall).toHaveBeenLastCalledWith(2, { overCap: true });
    expect(runAuditedLlmCall.mock.calls[1][0]).toMatchObject({ callId: 'call-2-final' });
  });

  it('W5: sends no forced answer when even that reservation is refused (an open breaker)', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }]));
    const beforeCall = vi.fn(async (round: number) => {
      if (round > 1) throw new BudgetExhaustedError();
    });

    const result = await runToolLoop(baseOptions({ beforeCall }));

    expect(result).toMatchObject({ stopReason: 'budget', content: '' });
    expect(runAuditedLlmCall).toHaveBeenCalledTimes(1);
  });

  it('does not spend a call to say nothing when the budget is gone before the first round', async () => {
    const beforeCall = vi.fn(async () => {
      throw new BudgetExhaustedError();
    });

    const result = await runToolLoop(baseOptions({ beforeCall }));

    expect(result.stopReason).toBe('budget');
    expect(result.content).toBe('');
    expect(runAuditedLlmCall).not.toHaveBeenCalled();
  });

  it('reports every round to onRound as it completes, for live progress', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }])).mockResolvedValueOnce(reply('done'));
    const seen: Array<{ index: number; names: string[] }> = [];

    await runToolLoop(baseOptions({ onRound: (round) => seen.push({ index: round.index, names: round.calls.map((call) => call.name) }) }));

    expect(seen).toEqual([
      { index: 1, names: ['get_files'] },
      { index: 2, names: [] },
    ]);
  });

  it('runs several tool calls from one turn and records each', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('', [{ name: 'get_files' }, { name: 'get_commits' }])).mockResolvedValueOnce(reply('both'));
    const options = baseOptions();

    const result = await runToolLoop(options);

    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(result.rounds[0].calls.map((call) => call.name)).toEqual(['get_files', 'get_commits']);
    expect(result.toolsUsed).toEqual(['get_files', 'get_commits']);
  });

  it('stops accepting tool output once the whole-run byte budget is spent', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files', arguments: '{"n":1}' }]))
      .mockResolvedValueOnce(reply('', [{ name: 'get_commits', arguments: '{"n":2}' }]))
      .mockResolvedValueOnce(reply('answered from the first result'));
    const options = baseOptions({ execute: vi.fn(async () => ({ rows: 'y'.repeat(600) })), maxTotalResultBytes: 400, maxResultBytes: 5_000 });

    await runToolLoop(options);

    // First call runs and overshoots the total; the second is refused with an
    // instruction to answer, rather than silently returning nothing.
    expect(options.execute).toHaveBeenCalledTimes(1);
    const toolMessage = JSON.parse(runAuditedLlmCall.mock.calls[2][0].messages.at(-1).content);
    expect(toolMessage.error).toContain('no room left for more tool output');
  });

  /**
   * The journal's real failure: after six rounds of tool results the model
   * opened with "I have enough data to write the journal now. Let me synthesize
   * what I've gathered:" and wrote prose, and a whole day of research was thrown
   * away by a parser returning null.
   */
  it('asks once more for the format when the caller\'s validator rejects the reply', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('I have enough data now. Let me synthesize what I gathered:'))
      .mockResolvedValueOnce(reply('{"tldr":"ok"}'));

    const result = await runToolLoop(baseOptions({ validate: (c: string) => c.trim().startsWith('{') }));

    expect(result.content).toBe('{"tldr":"ok"}');
    expect(runAuditedLlmCall).toHaveBeenCalledTimes(2);
    // Tools are withheld on the repair turn for the same reason as the forced one.
    expect(runAuditedLlmCall.mock.calls[1][0].tools).toBeUndefined();
    expect(runAuditedLlmCall.mock.calls[1][0].messages.at(-1).content).toContain('not in the required format');
    // The rejected prose is handed back as the assistant turn, so the model
    // reformats what it wrote rather than re-researching the whole day.
    expect(runAuditedLlmCall.mock.calls[1][0].messages.at(-2)).toMatchObject({ role: 'assistant', content: 'I have enough data now. Let me synthesize what I gathered:' });
  });

  it('does not spend a repair turn when the reply already validates', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('{"tldr":"fine"}'));

    const result = await runToolLoop(baseOptions({ validate: (c: string) => c.trim().startsWith('{') }));

    expect(result.content).toBe('{"tldr":"fine"}');
    expect(runAuditedLlmCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the original reply when the repair turn also fails to validate', async () => {
    runAuditedLlmCall.mockResolvedValueOnce(reply('prose one')).mockResolvedValueOnce(reply('prose two'));

    const result = await runToolLoop(baseOptions({ validate: (c: string) => c.trim().startsWith('{') }));

    // Never worse than what came back the first time; the caller's null-handling
    // is the honest floor, and asking a third time would not help.
    expect(result.content).toBe('prose one');
  });

  it('repairs the forced end-of-loop answer too, not just a voluntary one', async () => {
    runAuditedLlmCall
      .mockResolvedValueOnce(reply('', [{ name: 'get_files' }]))
      .mockResolvedValueOnce(reply('prose instead of json'))
      .mockResolvedValueOnce(reply('{"tldr":"recovered"}'));

    const result = await runToolLoop(baseOptions({ maxRounds: 1, validate: (c: string) => c.trim().startsWith('{') }));

    expect(result.content).toBe('{"tldr":"recovered"}');
    expect(result.stopReason).toBe('max-rounds');
  });

  it('propagates a transport error rather than pretending the run succeeded', async () => {
    runAuditedLlmCall.mockRejectedValueOnce(new Error('endpoint returned 500'));

    await expect(runToolLoop(baseOptions())).rejects.toThrow('endpoint returned 500');
  });
});
