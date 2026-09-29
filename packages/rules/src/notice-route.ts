import type { KernelState, NoticeRoute, Rule } from '@sundial/kernel/types.js';
import { NOT_A_CALL_APPS } from '@sundial/kernel/watch.js';
import { isZeroActivity } from './idle-track.js';

/** Focus modes that hold an interruption. `off` and `unknown` do not. */
const HOLDING_FOCUS = new Set(['do-not-disturb', 'work', 'personal', 'sleep', 'custom']);

/**
 * A calendar block this long is a day marker, not a call. Measured on 14 days
 * of the live record: 26 meetings, 1 of them a 33-hour block with nobody in it;
 * the longest real one ran 5 hours.
 */
const MAX_MEETING_MS = 8 * 3_600_000;

/**
 * A call now: an app holds the microphone, or the calendar says a meeting is running.
 *
 * Gnomon's own hearing holds the microphone too, under the app's name. It is
 * not a call: measured on the same 14 days, it was the mic's holder in 457 of
 * 613 samples with the mic on.
 */
function callNow(state: KernelState, ts: string): boolean {
  const call = state.av.call;
  if (call !== null && !NOT_A_CALL_APPS.some((name) => call.app.toLowerCase().includes(name))) return true;
  const meeting = state.schedule.active;
  // A block with nobody else in it (focus time, lunch) is not a call.
  return meeting !== null && (meeting.others ?? 1) > 0 && Date.parse(ts) <= Date.parse(meeting.end) && Date.parse(meeting.end) - Date.parse(meeting.start) <= MAX_MEETING_MS;
}

/** The route for this state, before the per-kind exception `routeFor` makes. Call > focus > away > active. */
function routeOf(state: KernelState, awaySince: string | null, ts: string): Pick<NoticeRoute, 'channel' | 'reason'> {
  if (callNow(state, ts)) return { channel: 'hold', reason: 'call' };
  if (HOLDING_FOCUS.has(state.focusMode.state)) return { channel: 'hold', reason: 'focus' };
  if (awaySince !== null) return { channel: 'phone', reason: 'away' };
  return { channel: 'mac', reason: 'active' };
}

/**
 * #6 the right channel: ONE router for where an interruption goes.
 *
 * Reads what earlier rules folded (`state.av` from `callSpanTrack`,
 * `state.schedule.active` from `scheduleTrack`, `state.focusMode` from
 * `focusModeTrack`) and keeps its own "away" clock: idle or asleep until the
 * first real input, the same edges the gate's away hold uses. It writes only
 * `state.route`; the gate reads it through `routeFor` and the delivery plugin
 * reads the answer on the phasic `Notify`.
 *
 * There is no screen-lock signal in the log. A locked Mac reads as away once
 * `idle:start` fires (about 5 minutes without input), or at once when it sleeps.
 */
export const noticeRoute: Rule = (state, event) => {
  const route = state.route;
  // First event after deploy: take the gate's own away clock, so an owner already away is not read as at the Mac.
  let awaySince = route.since === null ? (route.awaySince ?? state.notices.away?.since ?? null) : route.awaySince;
  if (event.type === 'idle:start' || (event.type === 'system:sleep-wake' && (event.payload as { kind?: unknown }).kind === 'sleep')) awaySince ??= event.ts;
  else if (event.type === 'input:activity' && awaySince !== null && !isZeroActivity(event.payload)) awaySince = null;

  const next = routeOf(state, awaySince, event.ts);
  if (next.channel === route.channel && next.reason === route.reason && awaySince === route.awaySince) return { state, effects: [] };
  const since = next.channel === route.channel && next.reason === route.reason ? route.since : event.ts;
  return { state: { ...state, route: { ...next, since, awaySince } }, effects: [] };
};

/**
 * The channel for one interruption of this kind. A focus mode holds everything
 * but a question Gnomon asked the owner; that one goes where it would without
 * the focus. A call holds everything.
 */
export function routeFor(route: NoticeRoute, kind: string): NoticeRoute['channel'] {
  if (route.channel === 'hold' && route.reason === 'focus' && kind === 'owner-question') return route.awaySince !== null ? 'phone' : 'mac';
  return route.channel;
}
