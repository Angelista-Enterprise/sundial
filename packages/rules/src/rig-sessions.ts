import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js';
import type { Rule } from '@sundial/kernel/types.js';

/**
 * Round 4: the screen rig's chat sessions, on the record. The rig sets its run thread's model through
 * `/gnomon/api/model` with `by: 'rig'` (lab/screen-rig start.sh, and rest.sh on a resume), and that
 * `thread:model` row carries `rig: true`; the owner's own model change carries nothing. The single writer
 * of `state.rigSessions`: id → first seen (event time), the newest 1000, a session seen again moved to the
 * end. The companion thread is never marked: a rig that fell back to it shares it with the owner, and
 * missing a rig turn costs less than dropping every owner turn there. Before every owner learner, which
 * asks `isRigSession`.
 *
 * Only that explicit row marks a session. Set 3 R4 also marked one by the rig's signs in a task's text or a step's
 * window (Testbox, a fixture folder), and the review found the hole: the owner is the rig's developer, types those
 * words, and can keep a mailbox named Testbox, so their own side thread was marked for good and nothing unmarked it.
 * The old, unmarked rig chats are found by the lab scripts instead (`lab/chores/rig-chats.mjs`: SQL signs and the
 * rig's own run files), which only read.
 *
 * S4: since the gate routes the daily write tools by this mark, it outlives a busy rig: the newest 1000 (a few dozen
 * bytes each), not 50. And a helper a rig chat starts is a rig chat too: `thread:delegate {sessionId, parent}` (the
 * proactive plugin, on `subagent/start`) marks the child when its parent is marked.
 */
export const RIG_SESSIONS_KEPT = 1000;

export const rigSessions: Rule = (state, event) => {
  const p = event.payload;
  const id = typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
  const marked = event.type === 'thread:model' ? p.rig === true : event.type === 'thread:delegate' && typeof p.parent === 'string' && state.rigSessions?.[p.parent] !== undefined;
  if (!marked || id === '' || id === COMPANION_SESSION_ID) return { state, effects: [] };
  const was = state.rigSessions ?? {};
  const kept = Object.entries(was).filter(([k]) => k !== id);
  return { state: { ...state, rigSessions: Object.fromEntries([...kept, [id, was[id] ?? event.ts]].slice(-RIG_SESSIONS_KEPT)) }, effects: [] };
};
