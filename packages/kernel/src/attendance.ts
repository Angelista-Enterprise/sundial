import type { KernelState } from './types.js';

/**
 * Was the owner in the meeting? The calendar says a meeting was ON; only the
 * signals say the owner was IN it. Everything that assumes they were — the
 * "how did it go" question, "back from X", the promise pass, attendee questions,
 * the meeting-ended moment — asks this, and acts only on `joined`.
 *
 * `meetingFollowup` samples the evidence once a minute while the meeting runs
 * (`ticks`): a call app holding the microphone or camera (`called`, never
 * Sundial's own hearing), the owner at the keys (`active`), the laptop on the
 * network labelled home (`home`). Hearing adds what the room said (`heard`).
 *
 * Measured on 71 calendar meetings (2026-09-10 → 10-07): a call app held the
 * microphone in about a third; most had no evidence either way, which is why
 * `unknown` exists and is not treated as attended. Declined meetings never get
 * here: the calendar sensor and `scheduleTrack` drop them.
 */
export type Attendance = 'joined' | 'absent' | 'unknown';
type Seen = KernelState['meetings']['seen'][string];

/** Fewer microphone utterances per minute than this, with hearing awake, is a room the owner was not in. */
export const ABSENT_BELOW_PER_MIN = 1;
/** Samples needed before the keys or the network may say "absent". */
export const MIN_TICKS = 3;

export function attendanceOf(m: Seen): Attendance {
  // The owner's own word beats any sample.
  if (m.confirmed === 'yes') return 'joined';
  if (m.confirmed === 'no') return 'absent';
  const minutes = Math.max(1, (Date.parse(m.end) - Date.parse(m.start)) / 60_000);
  const heard = m.heard ?? 0;
  if (m.called || heard >= minutes * ABSENT_BELOW_PER_MIN) return 'joined';
  // Hearing awake and almost nothing said. Zero is not absence: a dead transcriber hears nothing too.
  if (m.listened && heard > 0) return 'absent';
  const ticks = m.ticks ?? 0;
  if (ticks >= MIN_TICKS) {
    // An online meeting needs a call app; at the keys with none open, the owner was not in it.
    if (m.online && (m.active ?? 0) / ticks >= 0.5) return 'absent';
    // An in-person meeting with the laptop at home.
    if (!m.online && (m.home ?? 0) / ticks >= 0.5) return 'absent';
  }
  return 'unknown';
}
