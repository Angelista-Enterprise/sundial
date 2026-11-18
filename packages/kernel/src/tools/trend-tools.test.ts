import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, EMPTY_DRIFT, EMPTY_DRIFT_DAY, type DriftDay } from '../drift.js';
import { createInitialState } from '../initial-state.js';
import { toolEnv } from '../tool-env.js';
import { TREND_TOOLS } from './trend-tools.js';

const mocks = vi.hoisted(() => ({ getAllSignalsInRange: vi.fn() }));
vi.mock('@sundial/db/index.js', () => mocks);
vi.mock('@sundial/helpers/sundial-config.js', async (original) => ({ ...(await original<object>()), loadSundialConfig: () => ({ timezone: 'UTC' }) }));

const tool = (name: string) => TREND_TOOLS.find((t) => t.name === name)!;
const NOW = new Date('2026-11-18T12:00:00.000Z');
const day = (last: number): DriftDay => ({ ...EMPTY_DRIFT_DAY, first: 300, last, active: 360, switches: 20 });
const week = (monday: string, last: number) => Object.fromEntries(Array.from({ length: 7 }, (_, i) => [addDays(monday, i), day(last)]));

beforeEach(() => mocks.getAllSignalsInRange.mockReset());

describe('gnomon_drift', () => {
  it('says so when no drift day is recorded yet', async () => {
    const state = createInitialState('d1');
    expect(await tool('gnomon_drift').handler({}, toolEnv(() => state, NOW))).toEqual({ note: expect.stringMatching(/^No drift days recorded yet/) });
  });

  it('gives the newest weeks with the day end as a clock, and the trend that holds', async () => {
    const state = createInitialState('d1');
    state.config.timezone = 'UTC';
    state.drift = { ...EMPTY_DRIFT, days: { ...week('2026-09-28', 840), ...week('2026-10-05', 840), ...week('2026-10-12', 840), ...week('2026-10-19', 840), ...week('2026-10-26', 900), ...week('2026-11-02', 900), ...week('2026-11-09', 900) } };
    const out = (await tool('gnomon_drift').handler({ weeks: 2 }, toolEnv(() => state, NOW))) as Record<string, any>;
    expect(out.weeks.map((w: { week: string; dayEnd: string }) => [w.week, w.dayEnd])).toEqual([
      ['2026-11-02', '19:00'],
      ['2026-11-09', '19:00'],
    ]);
    expect(out.holding).toEqual([{ metric: 'dayEnd', direction: 'up', said: 'Your working day has ended later for 3 weeks in a row: 19:00, 19:00, 19:00, against 18:00 in the 4 weeks before.', baselineWeeks: 4 }]);
    expect(out.thresholds.dayEnd).toEqual({ abs: 30 });
  });
});

describe('gnomon_agent_yield', () => {
  it('reads the fleet, session and PR rows for the weeks asked, one row per project and week', async () => {
    const cwd = '~/Projects/puzzlebox-studio';
    mocks.getAllSignalsInRange.mockResolvedValue([
      { signalType: 'agent', eventType: 'fleet', capturedAt: '2026-11-17T09:00:00.000Z', data: { sessions: [{ id: 'aaaa0001', cwd, branch: 'feat/box-484', costUsd: 2 }] } },
      { signalType: 'agent', eventType: 'fleet', capturedAt: '2026-11-17T09:00:00.000Z', data: { sessions: [{ id: 'bbbb0002', cwd: '~/Projects/other-site', branch: 'main' }] } },
      // Before the first week asked: filtered out.
      { signalType: 'agent', eventType: 'fleet', capturedAt: '2026-11-01T09:00:00.000Z', data: { sessions: [{ id: 'cccc0003', cwd, branch: 'feat/old' }] } },
    ]);
    const out = (await tool('gnomon_agent_yield').handler({ weeks: 1, project: 'PUZZLE' }, toolEnv(() => null, NOW))) as Record<string, any>;
    const [from, , types] = mocks.getAllSignalsInRange.mock.calls[0]!;
    expect(from).toBe('2026-11-15T00:00:00.000Z');
    expect(types).toEqual(['agent:fleet', 'agent:session', 'git:pr-status']);
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ week: '2026-11-16', project: 'puzzlebox-studio', sessions: 1, costUsd: 2 });
    expect(out.rows[0].line).toMatch(/this week/);
    expect(out.note).toMatch(/estimate at list price/);
  });
});
