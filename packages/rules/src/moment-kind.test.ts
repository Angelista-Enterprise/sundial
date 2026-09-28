import { describe, it, expect } from 'vitest';
import type { MomentRollup } from '@sundial/kernel/types.js';
import { computeAudioContext, computeMomentKind } from './moment-kind.js';

function rollup(overrides: Partial<MomentRollup> = {}): MomentRollup {
  return {
    processName: 'Code',
    windowTitles: [],
    shellCommandCount: 0,
    notableCommands: [],
    gitCommitCount: 0,
    gitBranch: null,
    calendarActive: false,
    typingEventCount: 0, inputEventCount: 0, activeMs: 0,
    lifeEvents: [],
    projectSource: null,
    projectConfidence: null,
    micActive: false,
    cameraActive: false,
    meetingTitle: null,
    meetingAttendees: [],
    screenTopics: [],
    screenExcerpt: null,
    ...overrides,
  };
}

const NO_FOCUS = 0; // most tests exercise kind independent of focusScore

describe('computeMomentKind', () => {
  it('classifies a plain editor session with no other signal as setup', () => {
    expect(computeMomentKind(rollup(), NO_FOCUS)).toBe('setup');
  });

  it('P2c: a real meeting (calendar + attendees) wins, even over a focus-flow life event', () => {
    expect(computeMomentKind(rollup({ calendarActive: true, meetingAttendees: ['sam', 'ada'], lifeEvents: ['event:focus-flow'] }), 0.9)).toBe('meeting');
  });

  it('P2c: a real meeting via mic-on (no attendee list) still counts', () => {
    expect(computeMomentKind(rollup({ calendarActive: true, micActive: true }), NO_FOCUS)).toBe('meeting');
  });

  it('P2c: bare calendarActive (all-day, zero attendees, no mic/cam) is NOT a meeting', () => {
    // the all-day false-positive fix — falls through to setup
    expect(computeMomentKind(rollup({ calendarActive: true }), NO_FOCUS)).toBe('setup');
  });

  it('classifies an event:focus-flow life event as focus', () => {
    expect(computeMomentKind(rollup({ lifeEvents: ['event:focus-flow'] }), NO_FOCUS)).toBe('focus');
  });

  it('P2c: a high focusScore alone (no focus-flow event) classifies as focus', () => {
    expect(computeMomentKind(rollup(), 0.8)).toBe('focus');
  });

  it('classifies 3+ event:context-switch life events as switch, even in a browser', () => {
    expect(
      computeMomentKind(
        rollup({ processName: 'Safari', lifeEvents: ['event:context-switch', 'event:context-switch', 'event:context-switch'] }),
        NO_FOCUS,
      ),
    ).toBe('switch');
  });

  it('does not classify as switch below the density threshold', () => {
    expect(computeMomentKind(rollup({ lifeEvents: ['event:context-switch', 'event:context-switch'] }), NO_FOCUS)).toBe('setup');
  });

  it('classifies a browser process with no other signal as browse', () => {
    expect(computeMomentKind(rollup({ processName: 'Safari' }), NO_FOCUS)).toBe('browse');
    expect(computeMomentKind(rollup({ processName: 'Google Chrome' }), NO_FOCUS)).toBe('browse');
  });

  it('falls back to setup when nothing else applies', () => {
    expect(computeMomentKind(rollup({ processName: 'Xcode' }), NO_FOCUS)).toBe('setup');
  });

  it('classifies a short-but-engaged span (typing) as focus rather than setup', () => {
    expect(computeMomentKind(rollup({ typingEventCount: 12 }), NO_FOCUS)).toBe('focus');
  });

  it('classifies a short-but-engaged span (shell commands) as focus rather than setup', () => {
    expect(computeMomentKind(rollup({ shellCommandCount: 2 }), NO_FOCUS)).toBe('focus');
  });

  it('classifies a short-but-engaged span (git commits) as focus rather than setup', () => {
    expect(computeMomentKind(rollup({ gitCommitCount: 1 }), NO_FOCUS)).toBe('focus');
  });
});

// C17 — the audio-device proxy was refuted; this is the fused replacement.
describe('computeAudioContext', () => {
  it('a live mic or camera is a call', () => {
    expect(computeAudioContext(rollup({ micActive: true }))).toBe('call');
    expect(computeAudioContext(rollup({ cameraActive: true }))).toBe('call');
  });

  it('playback from a music app is music, not a call', () => {
    expect(computeAudioContext(rollup({ processName: 'Spotify', playbackActive: true, audioApp: 'Spotify' }))).toBe('music');
  });

  it('a browser playing a YouTube title is video', () => {
    expect(computeAudioContext(rollup({ processName: 'Google Chrome', playbackActive: true, audioApp: 'Google Chrome', windowTitles: ['Night Lovell - COLD SHOULDER - YouTube'] }))).toBe('video');
  });

  it('catches a SILENT (muted, no mic) Google Meet — the case A04 misses', () => {
    expect(computeAudioContext(rollup({ processName: 'Google Chrome', calendarActive: true, playbackActive: true, windowTitles: ['Standup - Google Meet'] }))).toBe('call');
  });

  it('a native conferencing app driving audio is a call even with no mic', () => {
    expect(computeAudioContext(rollup({ processName: 'zoom.us', playbackActive: true, audioApp: 'zoom.us' }))).toBe('call');
  });

  it('a browser playing unknown audio is unclassified audio, not video or music', () => {
    expect(computeAudioContext(rollup({ processName: 'Google Chrome', playbackActive: true, audioApp: 'Google Chrome', windowTitles: ['Some article'] }))).toBe('audio');
  });

  it('no playback and no mic is none', () => {
    expect(computeAudioContext(rollup({ processName: 'Code' }))).toBe('none');
  });
});

// A04's other half: the ad-hoc call the calendar never knew about. A live mic
// inside a meeting surface is a meeting; a bare mic is not — dictation, or a
// personal call (a real 3 h WhatsApp call once ran backgrounded under PR-review
// work; personal calls are deliberately not meetings).
describe('computeMomentKind ad-hoc meetings (no calendar event)', () => {
  it('a Slack huddle (mic on, Slack foreground, no calendar) is a meeting', () => {
    expect(computeMomentKind(rollup({ processName: 'Slack', micActive: true }), NO_FOCUS)).toBe('meeting');
  });

  it('a Meet browser tab with the mic on is a meeting', () => {
    expect(computeMomentKind(rollup({ processName: 'Google Chrome', windowTitles: ['Meet - uth-mkip-zwx - Google Chrome'], micActive: true }), NO_FOCUS)).toBe('meeting');
  });

  it('a Zoom app driving audio with the camera on is a meeting', () => {
    expect(computeMomentKind(rollup({ processName: 'zoom.us', cameraActive: true }), NO_FOCUS)).toBe('meeting');
  });

  it('a bare mic outside any meeting surface is NOT a meeting (dictation, stuck mic)', () => {
    expect(computeMomentKind(rollup({ processName: 'WhatsApp', micActive: true }), NO_FOCUS)).not.toBe('meeting');
    expect(computeMomentKind(rollup({ processName: 'Claude', micActive: true }), NO_FOCUS)).not.toBe('meeting');
  });

  it('a Slack window with no mic/camera is NOT a meeting', () => {
    expect(computeMomentKind(rollup({ processName: 'Slack' }), NO_FOCUS)).not.toBe('meeting');
  });

  it('Google Meet tab title counts as a call for audio context when playing', () => {
    expect(computeAudioContext(rollup({ processName: 'Google Chrome', windowTitles: ['Meet - Pat / Marlou - Overture FE check (online)'], playbackActive: true }))).toBe('call');
  });
});
