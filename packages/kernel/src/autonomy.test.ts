import { describe, expect, it } from 'vitest';
import { createInitialState } from './initial-state.js';
import { awaitingVerdict, evidenceOf } from './autonomy.js';
import type { WatchedNotice } from './types.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const stats = (n: number, hits: number, updatedAt: string | null = null) => ({ n, hits, sum: hits, updatedAt });
const watched = (key: string, kind: string, at: string, verdict?: string): WatchedNotice => ({ key, kind, channel: 'tonic', at, day: at.slice(0, 10), subject: null, sessionId: null, askId: null, cost: 0, app: null, leftAt: null, ...(verdict ? { verdict } : {}) });

describe('what else the record holds about a capability', () => {
  it('says the silent labels with their n, and how long the verdicts have been quiet', () => {
    const s = createInitialState('d1');
    s.calibrated.params['notice.seen:return-from-break'] = stats(93, 83);
    s.calibrated.params['notice.acted:return-from-break'] = stats(93, 0);
    s.calibrated.params['notice.precision:return-from-break'] = stats(7, 6, '2026-10-06T19:14:36.361Z');
    expect(evidenceOf(s, 'notice:return-from-break', NOW)).toEqual({ line: 'you were at the Mac after 83 of 93; did what it named after 0 of 93; last verdict 2026-10-06', lastVerdict: '2026-10-06T19:14:36.361Z', quietDays: 28 });
    expect(evidenceOf(s, 'notice:never-said', NOW)).toEqual({ line: 'last verdict never', lastVerdict: null, quietDays: null });
    s.calibrated.params['action.outward:gnomon_run_shell'] = stats(15, 5, '2026-10-06T09:34:36.084Z');
    expect(evidenceOf(s, 'actions', NOW).line).toBe('last outward call verified 2026-10-06');
  });

  it('offers the newest unjudged deliveries of a governed kind, never a reminder or an adopted rule', () => {
    const s = createInitialState('d1');
    s.calibrated.watch = [
      watched('a', 'agent-waiting', '2026-11-04T08:00:00Z'),
      watched('b', 'wakeup', '2026-11-04T09:00:00Z'),
      watched('c', 'watch:pile', '2026-11-04T10:00:00Z'),
      watched('d', 'commitment-quiet', '2026-11-04T10:30:00Z', 'useful'),
      watched('e', 'return-from-break', '2026-11-04T11:00:00Z'),
    ];
    expect(awaitingVerdict(s).map((w) => w.key)).toEqual(['e', 'a']);
  });
});
