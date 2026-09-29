import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { MAX_NOTICE_BIAS, MIN_AUTO_ADVANCE_MS, settingsTrack } from './settings-track.js';

const ev = (payload: Record<string, unknown>, ts = '2026-09-12T10:00:00.000Z'): SanitizedEvent => ({ id: `settings${ts}`, type: 'settings:set', ts, payload, sanitized: true });
const fold = (state: KernelState, ...events: SanitizedEvent[]) => events.reduce((s, e) => settingsTrack(s, e).state, state);

describe('settingsTrack', () => {
  it('changes only the fields the event names, and stamps when', () => {
    const s = fold(createInitialState('d1'), ev({ autonomy: 'off' }));
    expect(s.settings.autonomy).toBe('off');
    expect(s.settings.paper).toBe('system'); // untouched
    expect(s.settings.updatedAt).toBe('2026-09-12T10:00:00.000Z');
  });

  it('keeps only known notice groups as quiet, in catalogue order, and leaves them when not named', () => {
    let s = fold(createInitialState('d1'), ev({ quiet: ['promises', 'nonsense', 'agents', 'agents'] }));
    expect(s.settings.quiet).toEqual(['agents', 'promises']);
    s = fold(s, ev({ paper: 'dark' }, '2026-09-12T10:01:00.000Z'));
    expect(s.settings.quiet).toEqual(['agents', 'promises']);
    s = fold(s, ev({ quiet: [] }, '2026-09-12T10:02:00.000Z'));
    expect(s.settings.quiet).toEqual([]);
  });

  it('refuses a value outside the set, keeping what stood', () => {
    let s = fold(createInitialState('d1'), ev({ autonomy: 'notice', paper: 'dark' }));
    s = fold(s, ev({ autonomy: 'loud', paper: 'neon' }, '2026-09-12T10:01:00.000Z'));
    expect([s.settings.autonomy, s.settings.paper]).toEqual(['notice', 'dark']);
  });

  it('bounds the notice bias and the walk dwell, and takes null as "wait for Next"', () => {
    let s = fold(createInitialState('d1'), ev({ noticeBias: 99, autoAdvanceMs: 10 }));
    expect(s.settings.noticeBias).toBe(MAX_NOTICE_BIAS);
    expect(s.settings.autoAdvanceMs).toBe(MIN_AUTO_ADVANCE_MS);
    s = fold(s, ev({ autoAdvanceMs: null }, '2026-09-12T10:01:00.000Z'));
    expect(s.settings.autoAdvanceMs).toBeNull();
    // Omitted is "leave it", which null cannot mean here.
    s = fold(s, ev({ paper: 'light' }, '2026-09-12T10:02:00.000Z'));
    expect(s.settings.autoAdvanceMs).toBeNull();
  });

  it('is a no-op when a tab re-sends what already stands', () => {
    const s = fold(createInitialState('d1'), ev({ autonomy: 'act' }));
    expect(s.settings.updatedAt).toBeNull(); // 'act' is the default: nothing changed
    expect(settingsTrack(s, ev({}, '2026-09-12T11:00:00.000Z')).state).toBe(s);
  });

  it('ignores every other event', () => {
    const s = createInitialState('d1');
    expect(settingsTrack(s, { id: 'x', type: 'clock:tick', ts: '2026-09-12T10:00:00.000Z', payload: {}, sanitized: true }).state).toBe(s);
  });
});
