import { describe, expect, it } from 'vitest';
import { createInitialState } from '../initial-state.js';
import type { KernelState } from '../types.js';
import { knockAllowed, knockMode } from './knock.js';

const NOW = '2026-03-10T14:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const base = createInitialState('d1');
const voice = (over: Partial<NonNullable<KernelState['voice']>>) => ({ voice: { pendingKnock: null, recentLines: [], mutedUntil: null, ...over } });
const call = { app: 'Zoom', kind: 'work-call' as const, since: ago(60_000), cameraEver: false };

describe('knockAllowed (plan 15 step 1)', () => {
  it('yes at the Mac when nothing is in the way', () => {
    expect(knockAllowed(base, NOW)).toBe(true);
    expect(knockAllowed({ ...base, ...voice({ typedAt: ago(20_000), mutedUntil: ago(1) }) }, NOW)).toBe(true);
  });

  it.each<[string, Partial<KernelState>]>([
    ['the route is not the Mac', { route: { ...base.route, channel: 'phone' } }],
    ['the microphone is in use', { av: { call, lastCall: null } }],
    ['the camera is in use', { moment: { rollup: { cameraActive: true } } as never }],
    ['a focus mode is on', { focusMode: { ...base.focusMode, state: 'on' as never } }],
    ['the owner types', voice({ typedAt: ago(5_000) })],
    ['quiet for one hour', voice({ mutedUntil: new Date(Date.parse(NOW) + 60_000).toISOString() })],
    ['a knock is pending', voice({ pendingKnock: { noticeKey: 'k', mode: 'knock-wait', at: ago(1_000) } })],
  ])('no when %s', (_why, over) => {
    expect(knockAllowed({ ...base, ...over }, NOW)).toBe(false);
  });
});

describe('knockMode', () => {
  const alone: KernelState = { ...base, autonomy: { ...base.autonomy, levels: { 'notice:day-runs-long': { level: 'act', earned: true, since: ago(0) } } } };
  const ears = (s: KernelState): KernelState => ({ ...s, hearing: { ...s.hearing, listening: true } });

  it('waits for the go unless the kind may act alone and the ears hear a quiet room', () => {
    expect(knockMode(base, 'day-runs-long', NOW)).toBe('knock-wait');
    expect(knockMode(alone, 'day-runs-long', NOW)).toBe('knock-wait');
    expect(knockMode(ears(base), 'day-runs-long', NOW)).toBe('knock-wait');
    expect(knockMode(ears(alone), 'day-runs-long', NOW)).toBe('knock-speak');
    expect(knockMode({ ...ears(alone), ...voice({ heardAt: ago(30_000) }) }, 'day-runs-long', NOW)).toBe('knock-wait');
  });
});
