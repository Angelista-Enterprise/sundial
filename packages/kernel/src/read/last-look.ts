/**
 * SET4 R2, the hand-off: the newest look while it still shows what is in front (`frontLook`). Defined in @sundial/helpers,
 * so screen_look (sundial-actions, which does not depend on the kernel) reads the very same predicate the brief does.
 */
export { frontLook, LOOK_KEEP_MS, SETTLE_MS, type KeptLook } from '@sundial/helpers/last-look.js';
