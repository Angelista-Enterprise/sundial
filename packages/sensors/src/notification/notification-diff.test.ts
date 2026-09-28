import { describe, it, expect } from 'vitest';
import { createNotificationDiffState, diffNotificationSnapshot } from './index.js';
import type { BadgeSnapshot } from './notification-capture.js';

function snapshot(badges: Record<string, number>): BadgeSnapshot {
  return { timestamp: '2026-01-01T00:00:00.000Z', accessGranted: true, badges, totalCount: Object.values(badges).reduce((a, b) => a + b, 0) };
}

describe('diffNotificationSnapshot', () => {
  it('emits on the first non-zero snapshot with rising=true', () => {
    const state = createNotificationDiffState();
    const event = diffNotificationSnapshot(snapshot({ Slack: 2 }), state);

    expect(event?.payload.totalCount).toBe(2);
    expect(event?.payload.rising).toBe(true);
    expect(event?.payload.delta).toBe(2);
  });

  it('does not emit when the total is unchanged', () => {
    const state = createNotificationDiffState();
    diffNotificationSnapshot(snapshot({ Slack: 2 }), state);

    const event = diffNotificationSnapshot(snapshot({ Slack: 2 }), state);

    expect(event).toBeNull();
  });

  it('emits with rising=false when the total drops (badge cleared)', () => {
    const state = createNotificationDiffState();
    diffNotificationSnapshot(snapshot({ Slack: 3 }), state);

    const event = diffNotificationSnapshot(snapshot({ Slack: 0 }), state);

    expect(event?.payload.rising).toBe(false);
    expect(event?.payload.delta).toBe(-3);
  });

  it('filters to the allowlist when one is provided', () => {
    const state = createNotificationDiffState();
    const event = diffNotificationSnapshot(snapshot({ Slack: 2, Mail: 5 }), state, ['Slack']);

    expect(event?.payload.totalCount).toBe(2);
    expect(event?.payload.counts).toEqual([{ app: 'Slack', count: 2, source: 'dock-badge' }]);
  });
});
