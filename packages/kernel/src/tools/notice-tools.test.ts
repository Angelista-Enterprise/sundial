import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_TOOLS, channelOf, deliveredNotices } from './notice-tools.js';

const mocks = vi.hoisted(() => ({ getAllSignalsInRange: vi.fn() }));
vi.mock('@sundial/db/index.js', () => mocks);

// Made-up values only.
const row = (id: string, type: string, capturedAt: string, data: Record<string, unknown>) => ({ id, signalType: type.split(':')[0]!, eventType: type.split(':')[1]!, sessionId: null, capturedAt, data });
const ROWS = [
  row('c1', 'notice:candidate', '2026-10-01T08:00:00.000Z', { key: 'k-push', kind: 'unpushed', observation: 'Two commits on puzzlebox-studio wait to be pushed.' }),
  row('d1', 'notice:delivered', '2026-10-01T08:00:01.000Z', { noticeKey: 'k-push', sessionId: null, acts: ['inject', 'turn', 'banner'] }),
  row('s1', 'notice:seen', '2026-10-01T08:05:00.000Z', { noticeKey: 'k-push', surface: 'page' }),
  row('c2', 'notice:candidate', '2026-10-01T09:00:00.000Z', { key: 'k-meet', kind: 'meeting-prep', observation: 'Standup with Mira Bakker in 10 minutes.' }),
  row('d2', 'notice:delivered', '2026-10-01T09:00:01.000Z', { noticeKey: 'k-meet', sessionId: null, acts: ['inject'] }),
  // The same key again, later: a new notice, not yet seen.
  row('d3', 'notice:delivered', '2026-10-01T10:00:00.000Z', { noticeKey: 'k-push', sessionId: null, acts: ['inject', 'push'] }),
];

describe('deliveredNotices', () => {
  it('joins each delivery to its text and its seen mark, oldest first', () => {
    expect(deliveredNotices([...ROWS].reverse(), '2026-10-01T00:00:00.000Z')).toEqual([
      { id: 'd1', at: '2026-10-01T08:00:01.000Z', kind: 'unpushed', text: 'Two commits on puzzlebox-studio wait to be pushed.', channel: 'agent', acts: ['inject', 'turn', 'banner'], seen: true },
      { id: 'd2', at: '2026-10-01T09:00:01.000Z', kind: 'meeting-prep', text: 'Standup with Mira Bakker in 10 minutes.', channel: 'chat', acts: ['inject'], seen: false },
      { id: 'd3', at: '2026-10-01T10:00:00.000Z', kind: 'unpushed', text: 'Two commits on puzzlebox-studio wait to be pushed.', channel: 'phone', acts: ['inject', 'push'], seen: false },
    ]);
  });

  it('S4: a line a rig chat\'s sandbox drew (marked sandbox) is never one of the owner\'s notices', () => {
    const line = row('d9', 'notice:delivered', '2026-10-01T11:00:00.000Z', { noticeKey: 'wakeup:deploy:x', sessionId: 'session-rig', sandbox: 'session-rig', acts: ['line'] });
    expect(deliveredNotices([...ROWS, line], '2026-10-01T10:30:00.000Z')).toEqual([]);
  });

  it('is strictly after since', () => {
    expect(deliveredNotices(ROWS, '2026-10-01T09:00:01.000Z').map((n) => n.id)).toEqual(['d3']);
  });

  it('names the channel from the acts', () => {
    expect([channelOf(['inject', 'turn']), channelOf(['inject', 'banner']), channelOf(['push']), channelOf(['line'])]).toEqual(['agent', 'banner', 'phone', 'chat']);
  });
});

describe('gnomon_notices', () => {
  beforeEach(() => mocks.getAllSignalsInRange.mockReset());

  it('reads the three notice types from before since, and pages with nextSince', async () => {
    mocks.getAllSignalsInRange.mockResolvedValue(ROWS);
    const env = { now: new Date('2026-10-01T12:00:00.000Z'), state: async () => null };
    const out = (await NOTICE_TOOLS.find((t) => t.name === 'gnomon_notices')!.handler({ since: '2026-10-01T00:00:00.000Z', limit: 2 }, env)) as Record<string, any>;
    const [from, to, types] = mocks.getAllSignalsInRange.mock.calls[0]!;
    expect(types).toEqual(['notice:candidate', 'notice:delivered', 'notice:seen']);
    expect(from < '2026-10-01T00:00:00.000Z' && to === '2026-10-01T12:00:00.000Z').toBe(true);
    expect(out.total).toBe(3);
    expect(out.notices.map((n: { id: string }) => n.id)).toEqual(['d1', 'd2']);
    expect(out.nextSince).toBe('2026-10-01T09:00:01.000Z');
    expect(JSON.stringify(out).length).toBeLessThan(6_000);
  });
});
