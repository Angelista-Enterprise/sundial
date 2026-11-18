import { NOT_A_CALL_APPS } from '@sundial/kernel/watch.js';
import type { HearingReason, HearingWindow, Rule } from '@sundial/kernel/types.js';

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
const NOT_A_CALL = NOT_A_CALL_APPS;

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
    // A manual start holds its name: the owner asked for this window, and the
    // strip should keep saying so when a call lands inside it.
    reason: current.listening && current.reason === 'manual' ? 'manual' : reason,
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
 * Two things wake it: the owner's Listen, and a call (`media:state`: another
 * app holds the microphone). The call reason is OFF unless `audio.autoMeetings`
 * (`state.config.autoHearMeetings`), since nobody else in the room is told.
 *
 * The calendar no longer wakes it (2026-11-13). A calendar event is a plan, not
 * a room: a day-long event with attendees held the microphone and the system
 * audio tap open for 11 to 12 hours a day, transcribing every video played and
 * draining the battery. A meeting that happens on this Mac is a call.
 *
 * The window CLOSES on a clock tick rather than on an event, because "nothing
 * is happening" produces no events by definition.
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

  if (event.type === 'media:state' && state.config.autoHearMeetings !== true) return { state, effects: [] };

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
    // A window the calendar opened before 2026-11-13 is closed on the next tick.
    const calendar = state.hearing.reason === 'meeting' || state.hearing.reason === 'meeting-soon';
    if (!calendar && (until === null || now < until)) {
      if (muted === state.hearing.mutedUntil) return { state, effects: [] };
      return { state: { ...state, hearing: { ...state.hearing, mutedUntil: muted } }, effects: [] };
    }
    return { state: { ...state, hearing: { ...ASLEEP, mutedUntil: muted } }, effects: [] };
  }

  return { state, effects: [] };
};
