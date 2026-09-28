// The ask budget guard: an `llm/stream` waterfall listener that short-circuits
// on an exhausted daily cap and otherwise passes chunks through, recording the
// spend as the same `llm:dispatched` signal the daemon's recordLlmDispatch
// ingested.
import { describe, it, expect, vi } from 'vitest';
import { ASK_PURPOSE, BUDGET_EXHAUSTED_CODE, createAskBudgetGuard } from './budget.js';

function stateWithSpend(callsToday) {
  return { budgets: { day: '2026-08-15', byPurpose: { ask: { callsToday } } } };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const PASSTHROUGH_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
  { type: 'finish', reason: { kind: 'stop' } },
];

async function* fakeNext() {
  yield* PASSTHROUGH_CHUNKS;
}

describe('createAskBudgetGuard', () => {
  it('passes the stream through under budget and records ONE llm:dispatched spend with usage', async () => {
    const appendSignal = vi.fn().mockResolvedValue(undefined);
    const guard = createAskBudgetGuard({
      getState: () => stateWithSpend(3),
      getDailyCap: () => 400,
      appendSignal,
    });

    const next = vi.fn(() => fakeNext());
    const chunks = await collect(guard({}, next));

    expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
    expect(next).toHaveBeenCalledTimes(1);
    expect(appendSignal).toHaveBeenCalledTimes(1);
    expect(appendSignal).toHaveBeenCalledWith('llm:dispatched', {
      purpose: ASK_PURPOSE,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it('short-circuits with an error finish when the cap is reached — next() is never called, nothing is spent', async () => {
    const appendSignal = vi.fn();
    const guard = createAskBudgetGuard({
      getState: () => stateWithSpend(400),
      getDailyCap: () => 400,
      appendSignal,
    });

    const next = vi.fn(() => fakeNext());
    const chunks = await collect(guard({}, next));

    expect(next).not.toHaveBeenCalled();
    expect(appendSignal).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('finish');
    expect(chunks[0].reason.kind).toBe('error');
    expect(chunks[0].reason.failure.code).toBe(BUDGET_EXHAUSTED_CODE);
    expect(chunks[0].reason.failure.message).toContain('400/400');
  });

  it('short-circuits when kernel state is null (booting or shutting down)', async () => {
    const guard = createAskBudgetGuard({ getState: () => null, getDailyCap: () => 400, appendSignal: vi.fn() });
    const chunks = await collect(guard({}, () => fakeNext()));
    expect(chunks[0].reason.failure.code).toBe(BUDGET_EXHAUSTED_CODE);
    expect(chunks[0].reason.failure.message).toContain('no live budget state');
  });

  it('still records the spend when the provider stream throws mid-way (the call happened)', async () => {
    const appendSignal = vi.fn().mockResolvedValue(undefined);
    const guard = createAskBudgetGuard({
      getState: () => stateWithSpend(0),
      getDailyCap: () => 400,
      appendSignal,
    });

    async function* explodingNext() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      throw new Error('provider fell over');
    }

    await expect(collect(guard({}, () => explodingNext()))).rejects.toThrow('provider fell over');
    expect(appendSignal).toHaveBeenCalledTimes(1);
    expect(appendSignal).toHaveBeenCalledWith('llm:dispatched', { purpose: ASK_PURPOSE });
  });

  it('a failed spend append is contained (logged), not thrown into the stream', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guard = createAskBudgetGuard({
      getState: () => stateWithSpend(0),
      getDailyCap: () => 400,
      appendSignal: vi.fn().mockRejectedValue(new Error('db locked')),
    });

    const chunks = await collect(guard({}, () => fakeNext()));
    expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // The ledger seam: the same listener that meters the spend writes the row
  // the Ledger page projects. A counter says a call happened; the row says
  // which model answered and what it cost.
  describe('the ledger row', () => {
    function fakeAudit() {
      const audit = { observe: vi.fn(), settle: vi.fn().mockResolvedValue(undefined) };
      return { audit, recordAudit: vi.fn().mockResolvedValue(audit) };
    }

    it('opens a row with the request, sees every chunk, and settles once', async () => {
      const { audit, recordAudit } = fakeAudit();
      const guard = createAskBudgetGuard({
        getState: () => stateWithSpend(0),
        getDailyCap: () => Infinity,
        appendSignal: vi.fn(),
        recordAudit,
      });

      const options = { model: 'qwen/qwen3.8-2.4t-a95b', messages: [] };
      const chunks = await collect(guard(options, () => fakeNext()));

      expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
      expect(recordAudit).toHaveBeenCalledWith(options);
      expect(audit.observe).toHaveBeenCalledTimes(PASSTHROUGH_CHUNKS.length);
      expect(audit.settle).toHaveBeenCalledTimes(1);
      expect(audit.settle).toHaveBeenCalledWith(undefined);
    });

    it('settles with the error when the provider stream throws', async () => {
      const { audit, recordAudit } = fakeAudit();
      const guard = createAskBudgetGuard({
        getState: () => stateWithSpend(0),
        getDailyCap: () => Infinity,
        appendSignal: vi.fn(),
        recordAudit,
      });

      async function* explodingNext() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        throw new Error('provider fell over');
      }

      await expect(collect(guard({}, () => explodingNext()))).rejects.toThrow('provider fell over');
      expect(audit.settle).toHaveBeenCalledTimes(1);
      expect(audit.settle.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('writes NO row for a call the cap refused — it was never dispatched', async () => {
      const { recordAudit } = fakeAudit();
      const guard = createAskBudgetGuard({
        getState: () => stateWithSpend(400),
        getDailyCap: () => 400,
        appendSignal: vi.fn(),
        recordAudit,
      });

      await collect(guard({}, () => fakeNext()));
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('streams normally when the row could not be opened — the ledger never breaks the chat', async () => {
      const guard = createAskBudgetGuard({
        getState: () => stateWithSpend(0),
        getDailyCap: () => Infinity,
        appendSignal: vi.fn(),
        recordAudit: vi.fn().mockResolvedValue(null),
      });

      expect(await collect(guard({}, () => fakeNext()))).toEqual(PASSTHROUGH_CHUNKS);
    });
  });

  // The uncapped default (2026-08-15): Infinity never blocks, it only meters.
  describe('uncapped (the default `ask` cap)', () => {
    it('passes through no matter how much has been spent, and still records', async () => {
      const appendSignal = vi.fn();
      const guard = createAskBudgetGuard({
        getState: () => stateWithSpend(10_000),
        getDailyCap: () => Infinity,
        appendSignal,
      });

      const chunks = await collect(guard({}, () => fakeNext()));
      expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
      expect(appendSignal).toHaveBeenCalledWith('llm:dispatched', { purpose: ASK_PURPOSE, usage: { inputTokens: 10, outputTokens: 2 } });
    });

    it('proceeds even with no live budget state — a meter cannot gate what it cannot count', async () => {
      const appendSignal = vi.fn();
      const guard = createAskBudgetGuard({ getState: () => null, getDailyCap: () => Infinity, appendSignal });
      const chunks = await collect(guard({}, () => fakeNext()));
      // Passed through, not short-circuited...
      expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
      // ...and best-effort recorded (budget-track ignores a spend it can't seat).
      expect(appendSignal).toHaveBeenCalledWith('llm:dispatched', expect.objectContaining({ purpose: ASK_PURPOSE }));
    });
  });
});
