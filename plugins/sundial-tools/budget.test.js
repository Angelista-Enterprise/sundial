// The ask budget guard: an `llm/stream` waterfall listener that reserves the
// call through the kernel's one budget gate before the provider is contacted
// (W3), short-circuits on a refused reservation, and otherwise passes chunks
// through.
import { describe, it, expect, vi } from 'vitest';
import { ASK_PURPOSE, BREAKER_OPEN_CODE, BUDGET_EXHAUSTED_CODE, STREAM_IDLE_CODE, STREAM_IDLE_MS, createAskBudgetGuard } from './budget.js';
import { createLlmAuditRecorder } from './audit.js';

/**
 * A kernel stand-in with the real gate's shape: one lane, check-then-fold in
 * one step, so a reservation refused at the cap never reaches the provider.
 */
function fakeKernel(callsToday, cap) {
  const state = { budgets: { day: '2026-08-15', byPurpose: { ask: { callsToday } } } };
  const dispatched = [];
  let lane = Promise.resolve();
  let n = 0;
  const reserve = vi.fn((purpose, { caller }) => {
    const step = lane.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (state.budgets.byPurpose[purpose].callsToday >= cap) return null;
      state.budgets.byPurpose[purpose].callsToday += 1;
      const callId = `call-${(n += 1)}`;
      dispatched.push({ purpose, callId, caller });
      return callId;
    });
    lane = step;
    return step;
  });
  return { state, dispatched, reserve, getState: () => state, getDailyCap: () => cap };
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
  it('reserves ONE ask call before the provider is contacted, then passes the stream through', async () => {
    const kernel = fakeKernel(3, 400);
    const guard = createAskBudgetGuard(kernel);
    const next = vi.fn(() => {
      expect(kernel.dispatched).toHaveLength(1); // the spend is folded before next()
      return fakeNext();
    });
    expect(await collect(guard({}, next))).toEqual(PASSTHROUGH_CHUNKS);
    expect(next).toHaveBeenCalledTimes(1);
    expect(kernel.dispatched).toEqual([{ purpose: ASK_PURPOSE, callId: 'call-1', caller: 'chat:ask' }]);
  });

  it('short-circuits with an error finish when the reservation is refused — next() is never called', async () => {
    const kernel = fakeKernel(400, 400);
    const guard = createAskBudgetGuard(kernel);
    const next = vi.fn(() => fakeNext());
    const chunks = await collect(guard({}, next));

    expect(next).not.toHaveBeenCalled();
    expect(kernel.dispatched).toEqual([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('finish');
    expect(chunks[0].reason.kind).toBe('error');
    expect(chunks[0].reason.failure.code).toBe(BUDGET_EXHAUSTED_CODE);
    expect(chunks[0].reason.failure.message).toContain('400/400');
  });

  it('N parallel streams at a finite cap overshoot it by nothing', async () => {
    const kernel = fakeKernel(0, 3);
    const guard = createAskBudgetGuard(kernel);
    const next = vi.fn(() => fakeNext());
    const results = await Promise.all(Array.from({ length: 10 }, () => collect(guard({}, next))));
    expect(next).toHaveBeenCalledTimes(3);
    expect(kernel.state.budgets.byPurpose.ask.callsToday).toBe(3);
    expect(results.filter((chunks) => chunks[0].reason?.failure?.code === BUDGET_EXHAUSTED_CODE)).toHaveLength(7);
  });

  it('short-circuits when kernel state is null (booting or shutting down)', async () => {
    const reserve = vi.fn();
    const guard = createAskBudgetGuard({ getState: () => null, getDailyCap: () => 400, reserve });
    const chunks = await collect(guard({}, () => fakeNext()));
    expect(chunks[0].reason.failure.code).toBe(BUDGET_EXHAUSTED_CODE);
    expect(chunks[0].reason.failure.message).toContain('no live budget state');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('a stream that throws mid-way keeps its spend (the call happened)', async () => {
    const kernel = fakeKernel(0, 400);
    const guard = createAskBudgetGuard(kernel);
    async function* explodingNext() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      throw new Error('provider fell over');
    }
    await expect(collect(guard({}, () => explodingNext()))).rejects.toThrow('provider fell over');
    expect(kernel.state.budgets.byPurpose.ask.callsToday).toBe(1);
  });

  it('files an auxiliary dsh call (a session title) under its own caller, on the ask budget', async () => {
    const kernel = fakeKernel(0, Infinity);
    await collect(createAskBudgetGuard(kernel)({ purpose: 'title' }, () => fakeNext()));
    expect(kernel.dispatched).toEqual([{ purpose: ASK_PURPOSE, callId: 'call-1', caller: 'chat:title' }]);
  });

  // The ledger seam: the same listener that meters the spend writes the row
  // the Ledger page projects. A counter says a call happened; the row says
  // which model answered and what it cost.
  describe('the ledger row', () => {
    function fakeAudit() {
      const audit = { observe: vi.fn(), settle: vi.fn().mockResolvedValue(undefined) };
      return { audit, recordAudit: vi.fn().mockResolvedValue(audit) };
    }

    it('opens a row under the reservation id, sees every chunk, and settles once', async () => {
      const { audit, recordAudit } = fakeAudit();
      const guard = createAskBudgetGuard({ ...fakeKernel(0, Infinity), recordAudit });

      const options = { model: 'qwen/qwen3.8-2.4t-a95b', messages: [] };
      const chunks = await collect(guard(options, () => fakeNext()));

      expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
      expect(recordAudit).toHaveBeenCalledWith(options, 'call-1');
      expect(audit.observe).toHaveBeenCalledTimes(PASSTHROUGH_CHUNKS.length);
      expect(audit.settle).toHaveBeenCalledTimes(1);
      expect(audit.settle).toHaveBeenCalledWith(undefined);
    });

    it('settles with the error when the provider stream throws', async () => {
      const { audit, recordAudit } = fakeAudit();
      const guard = createAskBudgetGuard({ ...fakeKernel(0, Infinity), recordAudit });

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
      const guard = createAskBudgetGuard({ ...fakeKernel(400, 400), recordAudit });
      await collect(guard({}, () => fakeNext()));
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('streams normally when the row could not be opened — the ledger never breaks the chat', async () => {
      const guard = createAskBudgetGuard({ ...fakeKernel(0, Infinity), recordAudit: vi.fn().mockResolvedValue(null) });
      expect(await collect(guard({}, () => fakeNext()))).toEqual(PASSTHROUGH_CHUNKS);
    });
  });

  // The uncapped default (2026-08-15): Infinity never blocks, it only meters.
  describe('uncapped (the default `ask` cap)', () => {
    it('passes through no matter how much has been spent, and still reserves', async () => {
      const kernel = fakeKernel(10_000, Infinity);
      const chunks = await collect(createAskBudgetGuard(kernel)({}, () => fakeNext()));
      expect(chunks).toEqual(PASSTHROUGH_CHUNKS);
      expect(kernel.dispatched).toHaveLength(1);
    });

    it('proceeds even with no live budget state — a meter cannot gate what it cannot count', async () => {
      const reserve = vi.fn();
      const guard = createAskBudgetGuard({ getState: () => null, getDailyCap: () => Infinity, reserve });
      expect(await collect(guard({}, () => fakeNext()))).toEqual(PASSTHROUGH_CHUNKS);
      expect(reserve).not.toHaveBeenCalled();
    });
  });

  describe('W5: the chat route\'s breaker', () => {
    it('ends the turn at once with a clear message when the route is open, uncapped or not', async () => {
      const openUntil = new Date(Date.now() + 60_000).toISOString();
      const state = { budgets: { byPurpose: { ask: { callsToday: 0 } } }, reliability: { llm: { 'puzzlebox-llm': { streak: 12, openedAt: 'x', openUntil, days: [] } } } };
      const reserve = vi.fn(async () => null);
      const next = vi.fn(() => fakeNext());
      const chunks = await collect(createAskBudgetGuard({ getState: () => state, getDailyCap: () => Infinity, reserve })({ provider: 'puzzlebox-llm' }, next));
      expect(reserve).toHaveBeenCalledWith(ASK_PURPOSE, { caller: 'chat:ask', route: 'puzzlebox-llm' });
      expect(next).not.toHaveBeenCalled();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].reason.failure.code).toBe(BREAKER_OPEN_CODE);
      expect(chunks[0].reason.failure.message).toContain("'puzzlebox-llm' failed 12 calls in a row");
    });

    it('passes a closed route through', async () => {
      const kernel = fakeKernel(0, Infinity);
      kernel.state.reliability = { llm: { 'puzzlebox-llm': { streak: 3, openedAt: null, openUntil: null, days: [] } } };
      expect(await collect(createAskBudgetGuard(kernel)({ provider: 'puzzlebox-llm' }, () => fakeNext()))).toEqual(PASSTHROUGH_CHUNKS);
    });
  });

  describe('a stream that goes quiet', () => {
    it('ends the call after STREAM_IDLE_MS with a clear message and settles its row as a timeout', async () => {
      vi.useFakeTimers();
      try {
        const settled = [];
        const recordAudit = createLlmAuditRecorder({ openAudit: async (row) => ({ id: row.id, settle: async (patch) => void settled.push(patch) }), getMomentId: () => null });
        // What the E2E saw: a stream that started after a tool result, then never sent another chunk.
        async function* hungAfterToolResult() {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          await new Promise(() => {});
        }
        const out = collect(createAskBudgetGuard({ ...fakeKernel(0, Infinity), recordAudit })({ model: 'm', messages: [] }, () => hungAfterToolResult()));
        await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS - 1000);
        expect(settled).toEqual([]);
        await vi.advanceTimersByTimeAsync(2000);
        const chunks = await out;
        expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: STREAM_IDLE_CODE, message: expect.stringContaining('timed out') } } });
        expect(settled).toMatchObject([{ success: false, errorClass: 'timeout' }]);
        expect(STREAM_IDLE_MS).toBeLessThan(240_000); // the turn watchdog's: the turn ends here first, with its reason
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
