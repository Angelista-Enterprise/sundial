import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getAllSignalsInRange: vi.fn() }));
vi.mock('@sundial/db/index.js', () => mocks);
const { readOfferStats } = await import('./offer-stats.js');

const row = (type: string, data: Record<string, unknown>) => {
  const [signalType, eventType] = type.split(':');
  return { signalType, eventType, data };
};

describe('readOfferStats (Set 2 R3)', () => {
  it('counts offers shown and pressed, the slip and the knock apart, from the log', async () => {
    mocks.getAllSignalsInRange.mockResolvedValueOnce([
      // The knock is folded before the plugin records the delivery: still counted.
      row('voice:knock', { noticeKey: 'stuck:a', kind: 'stuck' }),
      row('notice:delivered', { noticeKey: 'stuck:a', offer: 'Show the run' }),
      row('voice:knock', { noticeKey: 'plain:b', kind: 'day-runs-long' }),
      row('notice:delivered', { noticeKey: 'plain:b' }),
      row('notice:seen', { noticeKey: 'stuck:a', surface: 'slip-offer' }),
      row('notice:seen', { noticeKey: 'stuck:c', surface: 'slip-offer' }),
      row('notice:seen', { noticeKey: 'stuck:a', surface: 'offer' }),
      row('notice:offer-taken', { noticeKey: 'stuck:a', via: 'knock' }),
      row('notice:offer-taken', { noticeKey: 'stuck:c', via: 'slip' }),
      row('notice:offer-taken', { noticeKey: 'stuck:d' }),
    ]);
    const stats = await readOfferStats({ now: Date.UTC(2026, 10, 15, 10) });
    expect(mocks.getAllSignalsInRange.mock.calls[0]![2]).toEqual(['notice:delivered', 'notice:seen', 'notice:offer-taken', 'voice:knock']);
    expect(stats).toEqual({ days: 30, slip: { shown: 2, pressed: 1 }, knock: { shown: 1, pressed: 1 } });
  });
});
