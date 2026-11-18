import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../initial-state.js';
import { toolEnv } from '../tool-env.js';
import { RELIABILITY_TOOLS } from './reliability-tools.js';

const mocks = vi.hoisted(() => ({ readScorecard: vi.fn() }));
vi.mock('../read/scorecard-history.js', () => mocks);

const tool = RELIABILITY_TOOLS.find((t) => t.name === 'gnomon_reliability')!;
const NOW = new Date('2026-11-16T10:00:00.000Z');

beforeEach(() => mocks.readScorecard.mockReset().mockResolvedValue([{ id: 14, metric: 'Retention prune last ran' }]));

describe('gnomon_reliability', () => {
  it('says so when there is no state yet, and reads nothing', async () => {
    expect(await tool.handler({}, toolEnv(() => null, NOW))).toEqual({ unavailable: 'No kernel state has been written yet.' });
    expect(mocks.readScorecard).not.toHaveBeenCalled();
  });

  it('reads every row over 30 days by default, with the autonomy levels beside them', async () => {
    const state = createInitialState('d1');
    state.autonomy = { ...state.autonomy, levels: { 'notice:wakeup': 'act' } } as never;
    const out = await tool.handler({}, toolEnv(() => state, NOW));
    expect(mocks.readScorecard).toHaveBeenCalledWith({ state, now: NOW.getTime(), days: 30 });
    expect(out).toEqual({ asOf: '2026-11-16T10:00:00.000Z', rows: [{ id: 14, metric: 'Retention prune last ran' }], autonomy: { 'notice:wakeup': 'act' } });
    await tool.handler({ days: 7 }, toolEnv(() => state, NOW));
    expect(mocks.readScorecard).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7 }));
  });
});
