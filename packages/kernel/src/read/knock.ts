import { capabilityOf, levelOf } from '../autonomy.js';
import type { KernelState } from '../types.js';

export type KnockMode = 'knock-wait' | 'knock-speak';

/** A key press this recent means the owner types. */
const TYPING_MS = 15_000;
/** Speech heard this recent means the room is not quiet. */
const ROOM_MS = 2 * 60_000;

const since = (at: string | null | undefined, now: string): number => (typeof at === 'string' ? Date.parse(now) - Date.parse(at) : Infinity);

/** May a notice knock now? No when the owner is not at the Mac, is on a call or camera, has a focus mode on, types, asked for quiet, or a knock already waits. */
export function knockAllowed(state: KernelState, now: string): boolean {
  const voice = state.voice;
  const focus = state.focusMode?.state ?? 'unknown';
  return (
    state.route.channel === 'mac' &&
    !state.av?.call &&
    state.moment?.rollup.cameraActive !== true &&
    (focus === 'off' || focus === 'unknown') &&
    since(voice?.typedAt, now) >= TYPING_MS &&
    !(typeof voice?.mutedUntil === 'string' && Date.parse(voice.mutedUntil) > Date.parse(now)) &&
    !voice?.pendingKnock
  );
}

/**
 * Knock and wait for a go, or knock and speak. It speaks without a go only for a kind that may act alone,
 * and only when hearing is on and heard nothing for two minutes: with hearing off nothing says the room is quiet.
 * ponytail: no notice carries a deadline yet; add that as a second way to `knock-speak` when one does.
 */
export function knockMode(state: KernelState, kind: string, now: string): KnockMode {
  const alone = levelOf(state, capabilityOf(kind)) === 'act';
  const quietRoom = state.hearing?.listening === true && since(state.voice?.heardAt, now) >= ROOM_MS;
  return alone && quietRoom ? 'knock-speak' : 'knock-wait';
}
