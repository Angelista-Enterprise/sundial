/**
 * SET4 R2, the hand-off: Gnomon's newest look (`marks.lastLook`) while it still shows what is in front. The brief says so
 * (`screen.lastLook` with `front: true`) and screen_look answers from it without a new look. Plain structural types, so the
 * plugins (which do not depend on @sundial/kernel) read the same predicate the brief does (kernel `read/last-look.ts`).
 *
 * Still in front: the window `window:changed` last put in front is the look's app and window, the look is at most
 * `LOOK_KEEP_MS` old, and nothing was done since: no act came after it (`marks.lastAct.at`), and the owner pressed no key
 * and clicked nothing after it (`lifeEvent.idle.ownerHandAt`, or the caller's fresher `handAt`). A refused look (a private
 * app's, a window that was not there) is never kept. An act's own after-look only once it is `SETTLE_MS` old.
 *
 * `task`: only a look of the task in flight in the chat `session` (`taskOf`, Set 5 R1: never another chat's, so a rig chat's
 * newer task never ends the owner's kept look, nor the reverse). Replayed over runs 211 to 226, a kept look whose fresh look listed
 * a different count: 11 of 13 across a task boundary (the rig's setup and a mail page change the screen with no window
 * event), 3 of 22 for an after-look under 3 s, 0 of 11 for the rest.
 */
import { taskOf, type TaskLike } from './task-of.js';

export const LOOK_KEEP_MS = 120_000;
export const SETTLE_MS = 3_000;
/** The clock skew a look's own time may have against the reader's. */
const SKEW_MS = 5_000;

export interface KeptLook { id: string; app: string; window?: string; n: number; at?: string; after?: string; refused?: string; tag?: string }
interface LookState {
  marks?: { lastLook?: KeptLook | null; lastAct?: { at?: string } | null } | null;
  window?: { active?: { processName: string; windowTitle: string } | null } | null;
  lifeEvent?: { idle?: { ownerHandAt?: string | null } } | null;
  task?: TaskLike | null;
  tasks?: Record<string, TaskLike>;
}

/** A window title as the fold keeps it on a look (mark-track `str(…, 120)`). */
const asKept = (s: unknown) => (typeof s === 'string' ? s.trim().slice(0, 120) : '');

export function frontLook(state: LookState | null | undefined, now: number, { handAt, task = false, session }: { handAt?: string | null; task?: boolean; session?: unknown } = {}): KeptLook | null {
  const look = state?.marks?.lastLook;
  const at = Date.parse(look?.at ?? '');
  if (!look || look.refused || !Number.isFinite(at) || now - at > LOOK_KEEP_MS || now - at < -SKEW_MS) return null;
  if (look.after && now - at < SETTLE_MS) return null;
  if (task && !(at >= Date.parse(taskOf(state, session)?.at ?? ''))) return null;
  const active = state?.window?.active;
  if (!active || active.processName !== look.app || asKept(active.windowTitle) !== (look.window ?? '')) return null;
  const since = (t: string | null | undefined) => Date.parse(t ?? '') > at;
  return since(state?.marks?.lastAct?.at) || since(state?.lifeEvent?.idle?.ownerHandAt) || since(handAt) ? null : look;
}
