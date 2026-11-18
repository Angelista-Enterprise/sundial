/**
 * Set 5 R2 (plan 21, 2E): what Gnomon opened and is still open, per chat, and the sheet or dialog in front that a task did not open.
 * Defined in @sundial/helpers, so screen_act (sundial-actions, which does not depend on the kernel) reads the very same predicate the
 * brief does.
 */
export { leftModal, leftOpen, openedLine, LEFT_MODAL_MS, type OpenedItem, type OpenedSlice } from '@sundial/helpers/opened.js';
