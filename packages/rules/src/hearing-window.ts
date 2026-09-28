import type { HearingReason, HearingWindow, Rule } from '@sundial/kernel/types.js';

/**
 * How long before a meeting starts to wake up.
 *
 * People join early, and the minute before a call is where "can you hear me"
 * and the actual first sentence live. Waking on the calendar's start instant
 * would miss both.
 */
const LEAD_MS = 3 * 60_000;

/**
 * How long after a meeting's scheduled end to keep listening.
 *
 * Meetings overrun. A calendar end is a plan, not an observation, and the last
 * five minutes are disproportionately the ones with the decisions in them.
 */
const OVERRUN_MS = 10 * 60_000;

/**
 * How long a call holds the window open after the microphone goes quiet.
 *
 * `media:state` is a sample, not a span: a brief dip — a device switch, a mute,
 * a poll landing between two frames — must not close a window mid-sentence.
 */
const CALL_GRACE_MS = 2 * 60_000;

/**
 * Processes whose microphone use is NOT evidence of a call, matched
 * case-insensitively as a substring.
 *
 * Gnomon's own helper is the one that matters, and the first version of this
 * list did not work. Once hearing wakes, the helper opens the microphone; the
 * AV sensor then reports an input process and the rule reads it as a call,
 * which extends the window, which keeps the microphone open — a latch that
 * never sleeps. The guard was written for exactly that and still failed,
 * because the helper is reported under the BUNDLE's display name,
 * `Sundial`, and the list said `gnomon-daemon`. Measured live: the window
 * flipped to `reason: "call"` within seconds of waking.
 *
 * So every name it can appear under is listed, and the match is
 * case-insensitive. A daemon that is always listening (`coreaudiod`) is here
 * for the separate reason the AV sensor's own notes give: system audio plumbing
 * holds the device without anyone being in a conversation.
 */
const NOT_A_CALL = ['sundial', 'gnomon', 'coreaudiod'];

/** How long a manual START listens for, when the owner names no length. */
const MANUAL_MS = 60 * 60_000;

/** The longest a manual START may ask for. Always-on is the thing that does not work. */
const MANUAL_MAX_MS = 4 * 60 * 60_000;

/**
 * How long a manual STOP keeps the window shut.
 *
 * Long enough to outlast the meeting the owner just stopped listening to, short
 * enough that a mute cannot silently swallow the afternoon.
 */
const MUTE_MS = 60 * 60_000;

interface CalendarEvent {
  title?: string;
  startDate?: string;
  endDate?: string;
  isAllDay?: boolean;
  attendees?: string[];
}

function parse(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A state replayed from a snapshot written before `hearing` existed has no window; asleep is the right reading of that. */
const ASLEEP: HearingWindow = { listening: false, reason: null, until: null, title: null, mutedUntil: null };

function open(state: Parameters<Rule>[0], reason: HearingReason, untilMs: number, title: string | null, nowMs: number) {
  const current = state.hearing ?? ASLEEP;
  // A manual stop outranks every automatic reason while it holds. Only the
  // owner's own start (below, which clears the mute first) gets past this.
  const mutedUntil = parse(current.mutedUntil);
  if (mutedUntil !== null && nowMs < mutedUntil) return { state, effects: [] };
  const currentUntil = parse(current.until) ?? 0;
  // A window only ever grows. Two reasons can overlap — a call inside a
  // meeting is the normal case — and whichever reaches furthest wins, so
  // neither can cut the other short.
  const until = new Date(Math.max(currentUntil, untilMs)).toISOString();
  const next: HearingWindow = {
    listening: true,
    // A meeting names the window; a call that happens to be inside one should
    // not rename it, because the title is what the transcript gets filed under.
    // A manual start holds its name for the same reason in reverse: the owner
    // asked for this window, and the strip should keep saying so.
    reason: current.listening && (current.reason === 'meeting' || current.reason === 'manual') ? current.reason : reason,
    until,
    title: title ?? (current.listening ? current.title : null),
    mutedUntil: current.mutedUntil,
  };
  if (current.listening && current.reason === next.reason && current.until === next.until && current.title === next.title) {
    return { state, effects: [] };
  }
  return { state: { ...state, hearing: next }, effects: [] };
}

/**
 * Decides WHEN ambient hearing is awake. See `HearingWindow` for why it sleeps
 * at all: handed a quiet room, whisper invents, and no confidence threshold
 * catches it because the model is not in doubt.
 *
 * Two things wake it, both already known to Gnomon:
 *
 * - **A meeting**, from `calendar:active` (one in progress) or
 *   `calendar:upcoming` (one about to start). An all-day event with no
 *   attendees is a marker in a calendar, not a room with people in it, and the
 *   same test `computeMomentKind` already uses keeps those asleep.
 * - **A call**, from `media:state` — something else is holding the microphone.
 *   This is the case the calendar cannot see: an unscheduled huddle, someone
 *   ringing, a call that runs long past its slot.
 *
 * The window CLOSES on a clock tick rather than on an event, because "nothing
 * is happening" produces no events by definition — that is what the old
 * always-on design got wrong in the other direction.
 */
export const hearingWindow: Rule = (state, event) => {
  // The owner's own hand, from the strip's listen chip. The third reason, and
  // the only one that is not inferred: the huddle the calendar never got, the
  // meeting someone else scheduled elsewhere, the hour they simply want heard.
  // A STOP mutes rather than merely closing, or the next calendar poll would
  // undo it within the minute (see `HearingWindow.mutedUntil`).
  if (event.type === 'hearing:set') {
    const now = Date.parse(event.ts);
    if (!Number.isFinite(now)) return { state, effects: [] };
    const payload = event.payload as { listen?: boolean; minutes?: number };
    if (payload.listen === true) {
      const asked = typeof payload.minutes === 'number' && payload.minutes > 0 ? payload.minutes * 60_000 : MANUAL_MS;
      const cleared = { ...state, hearing: { ...(state.hearing ?? ASLEEP), mutedUntil: null } };
      return open(cleared, 'manual', now + Math.min(asked, MANUAL_MAX_MS), null, now);
    }
    return { state: { ...state, hearing: { ...ASLEEP, mutedUntil: new Date(now + MUTE_MS).toISOString() } }, effects: [] };
  }

  if (event.type === 'calendar:active') {
    const meeting = (event.payload as { event?: CalendarEvent }).event;
    if (!meeting) return { state, effects: [] };
    // The same "is this a real meeting" test the moment kind uses: an all-day
    // block with nobody in it is a note to self.
    if (meeting.isAllDay === true && (meeting.attendees?.length ?? 0) === 0) return { state, effects: [] };
    const end = parse(meeting.endDate);
    if (end === null) return { state, effects: [] };
    const now = Date.parse(event.ts);
    if (!Number.isFinite(now)) return { state, effects: [] };
    return open(state, 'meeting', end + OVERRUN_MS, typeof meeting.title === 'string' ? meeting.title : null, now);
  }

  if (event.type === 'calendar:upcoming') {
    const events = (event.payload as { events?: CalendarEvent[] }).events ?? [];
    const now = Date.parse(event.ts);
    if (!Number.isFinite(now)) return { state, effects: [] };
    for (const meeting of events) {
      if (meeting.isAllDay === true && (meeting.attendees?.length ?? 0) === 0) continue;
      const start = parse(meeting.startDate);
      const end = parse(meeting.endDate);
      if (start === null || end === null) continue;
      // Only one that is actually near. A meeting this afternoon is not a
      // reason to listen all morning.
      if (start - now > LEAD_MS || end < now) continue;
      return open(state, 'meeting-soon', end + OVERRUN_MS, typeof meeting.title === 'string' ? meeting.title : null, now);
    }
    return { state, effects: [] };
  }

  if (event.type === 'media:state') {
    const media = event.payload as { audioInput?: boolean; audioInputProcess?: string | null };
    if (media.audioInput !== true) return { state, effects: [] };
    const process = typeof media.audioInputProcess === 'string' ? media.audioInputProcess : '';
    const lower = process.toLowerCase();
    if (NOT_A_CALL.some((name) => lower.includes(name))) return { state, effects: [] };
    const now = Date.parse(event.ts);
    if (!Number.isFinite(now)) return { state, effects: [] };
    return open(state, 'call', now + CALL_GRACE_MS, null, now);
  }

  // Nothing happening is not an event, so the close has to ride the clock.
  if (event.type === 'clock:tick') {
    const now = Date.parse(event.ts);
    if (!Number.isFinite(now)) return { state, effects: [] };
    // A mute that has run out is dropped on the same tick that would have
    // closed a window, so the automatic reasons can wake again without the
    // owner having to say anything.
    const mutedUntil = parse(state.hearing?.mutedUntil);
    const muted = mutedUntil !== null && now < mutedUntil ? state.hearing.mutedUntil : null;
    if (!state.hearing?.listening) {
      if (muted === state.hearing?.mutedUntil) return { state, effects: [] };
      return { state: { ...state, hearing: { ...state.hearing, mutedUntil: muted } }, effects: [] };
    }
    const until = parse(state.hearing.until);
    if (until === null || now < until) {
      if (muted === state.hearing.mutedUntil) return { state, effects: [] };
      return { state: { ...state, hearing: { ...state.hearing, mutedUntil: muted } }, effects: [] };
    }
    return { state: { ...state, hearing: { ...ASLEEP, mutedUntil: muted } }, effects: [] };
  }

  return { state, effects: [] };
};
