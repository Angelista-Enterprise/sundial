/**
 * Round 4: whether a chat session is the screen rig's (its run thread said `by: 'rig'` when it set the
 * thread's model; `rigSessions` folds that). Every owner learner asks this before it reads a turn: the
 * rig's test chats look exactly like the owner's.
 *
 * S4: and the sandbox beside it. `sandboxOf(state, event)` names the rig chat whose sandbox a row belongs to
 * (null: the owner's). `reduce` asks it once per event, at the root: a sandboxed row reaches the `sandbox`
 * lane and no owner rule, so no owner view, learner or selector can see one. Defined in @sundial/helpers so
 * the plugins that write and deliver those rows read the very same predicate.
 */
export { isRigSession, rigRow, sandboxOf, sandboxed, sandboxView, SANDBOX_CHANNEL, SANDBOX_SLICES, SANDBOX_TYPES } from '@sundial/helpers/sandbox.js';

/** The name of the one rule a sandboxed row reaches (packages/rules sandbox.ts). */
export const SANDBOX_LANE = 'sandbox';
