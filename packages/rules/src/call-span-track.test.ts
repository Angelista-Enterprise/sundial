import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { callSpanTrack } from './call-span-track.js';

const media = (ts: string, app: string | null): SanitizedEvent => ({ id: ts, type: 'media:state', ts, payload: { audioInput: app !== null, audioInputProcess: app, camera: false }, sanitized: true });

describe('callSpanTrack', () => {
  it('opens a call when a conferencing app takes the microphone, and closes it when it lets go', () => {
    let s = callSpanTrack(createInitialState('d'), media('2026-10-07T09:00:00.000Z', 'zoom.us')).state;
    expect(s.av.call).toMatchObject({ app: 'zoom.us', since: '2026-10-07T09:00:00.000Z' });
    s = callSpanTrack(s, media('2026-10-07T09:30:00.000Z', null)).state;
    expect(s.av).toMatchObject({ call: null, lastCall: { app: 'zoom.us', until: '2026-10-07T09:30:00.000Z' } });
  });

  it('files macOS\'s own call service as a personal call', () => {
    expect(callSpanTrack(createInitialState('d'), media('2026-10-07T09:00:00.000Z', 'avconferenced')).state.av.call?.kind).toBe('personal-call');
  });

  it('never reads Sundial\'s own hearing as a call (it held the microphone in most meetings)', () => {
    for (const own of ['Sundial', 'Gnomon Daemon', 'sundial-audio-helper']) {
      expect(callSpanTrack(createInitialState('d'), media('2026-10-07T09:00:00.000Z', own)).state.av.call).toBeNull();
    }
  });
});
