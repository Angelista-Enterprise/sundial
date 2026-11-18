import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getAllSignalsInRange: vi.fn() }));
vi.mock('@sundial/db/index.js', () => mocks);
const { readVoiceStats } = await import('./voice-stats.js');

const row = (type: string, sec: number, data: Record<string, unknown>) => {
  const [signalType, eventType] = type.split(':');
  return { id: `${type}-${sec}`, signalType, eventType, sessionId: null, data, capturedAt: new Date(Date.UTC(2026, 10, 15, 9, 0, sec)).toISOString() };
};

describe('readVoiceStats: the step lines (Round 5, NEXT 3.1)', () => {
  it('counts the step lines sent, and those that began to sound before their act was answered', async () => {
    mocks.getAllSignalsInRange.mockResolvedValueOnce([
      // act-1: began at 1, answered at 2 (early). act-2: answered at 3, began at 4 (late). act-3: sent, never said (dropped as late).
      row('voice:line', 0, { line: 'Open Finder', tool: 'screen_act', stepId: 'act-1' }),
      row('voice:said', 1, { text: 'Open Finder', mode: 'step', stepId: 'act-1' }),
      row('screen:acted', 2, { id: 'act-1', outcome: 'performed' }),
      row('voice:line', 2, { line: 'Press New Folder', tool: 'screen_act', stepId: 'act-2' }),
      row('screen:acted', 3, { id: 'act-2', outcome: 'performed' }),
      row('voice:said', 4, { text: 'Press New Folder', mode: 'step', stepId: 'act-2' }),
      row('voice:line', 5, { line: 'Open the Sort By menu', tool: 'screen_act', stepId: 'act-3' }),
      row('voice:line', 6, { line: 'One moment.', tool: 'gnomon_today_summary' }),
      row('voice:said', 9, { text: 'Open Finder. Done.', mode: 'reply', nodMs: 120, firstWordMs: 900 }),
    ]).mockResolvedValueOnce([]);
    const stats = await readVoiceStats({ now: Date.UTC(2026, 10, 15, 10) });
    expect(mocks.getAllSignalsInRange.mock.calls[0]![2]).toEqual(['voice', 'screen:acted', 'screen:step']);
    expect(stats.stepLines).toEqual({ n: 3, early: 1 });
    expect(stats.turns).toBe(1);
  });

  it('Set 2 R1 item 5: counts the refused steps of a spoken turn, and those said with the next step', async () => {
    mocks.getAllSignalsInRange.mockReset();
    mocks.getAllSignalsInRange
      .mockResolvedValueOnce([
        // act-4 refused in the spoken turn and said with act-5; act-6 refused in it and never said; act-7 refused
        // in a typed session; act-8 refused in the spoken session, but three minutes after its turn began.
        row('screen:step', 10, { id: 'act-4', session: 'session-7f', ok: false, reason: 'not-found' }),
        row('voice:line', 11, { line: 'Sort By not found. Open the View menu.', tool: 'screen_act', stepId: 'act-5', refused: 'act-4' }),
        row('screen:step', 12, { id: 'act-5', session: 'session-7f', ok: true }),
        row('screen:step', 20, { id: 'act-6', session: 'session-7f', ok: false, reason: 'covered' }),
        row('screen:step', 21, { id: 'act-7', session: 'session-2a', ok: false, reason: 'not-found' }),
        { ...row('screen:step', 0, { id: 'act-8', session: 'session-7f', ok: false, reason: 'not-found' }), capturedAt: new Date(Date.UTC(2026, 10, 15, 9, 3, 5)).toISOString() },
      ])
      .mockResolvedValueOnce([row('chat:shown', 5, { sessionId: 'session-7f', hints: { voice: true } })]);
    const stats = await readVoiceStats({ now: Date.UTC(2026, 10, 15, 10) });
    expect(mocks.getAllSignalsInRange.mock.calls[1]!.slice(2)).toEqual([['chat:shown'], '"voice":true']);
    expect(stats.refusals).toEqual({ n: 2, said: 1 });
  });
});
