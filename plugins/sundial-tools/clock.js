// The dsh agent's clock.
//
// A model has no clock, and `/ask` has always said so outright: `nowLine`
// spells out the date, yesterday's date, the weekday and the timezone in the
// context block `askContextBlock` builds. The measured failure it fixes is on
// record — asked about "yesterday", a model with no stated date guessed
// 2026-07-29 on a day that was 2026-08-02, passed the guess to
// `gnomon_today_summary`, got nothing back, and truthfully reported that
// nothing was tracked. Every component behaved correctly and the answer was
// still wrong.
//
// The dsh harness reintroduced exactly that starting condition. Its persona is
// a static string in cordis.patch.yml, so no date can be interpolated into it,
// and nothing in the agent loop states one — while every gnomon_* tool takes a
// `date` argument the model must supply. This closes it.
//
// Registered as `systemPrompt.context` rather than `.section` on purpose. A
// section is the model's standing instructions; this is a fact about right now,
// and dsh materialises contexts as a durable snapshot re-resolved at each
// assembly. That re-resolution is the point: the companion session is
// persistent and stays open across midnight, so a date frozen at boot would go
// stale in the one session that lives longest.
//
// Named exports only.
import { gnomonClockLine } from '@sundial/kernel/tools/ask-prompt.js';

export const CLOCK_CONTEXT_NAME = 'gnomon:now';

/**
 * Ordered ahead of dsh's own runtime context (git status, directory listing).
 * The date is the thing most likely to be needed and cheapest to read, and a
 * negative order keeps it out of the middle of a long file tree.
 */
export const CLOCK_CONTEXT_ORDER = -50;

/**
 * The prompt-context contribution.
 *
 * @param now - fixed clock, for tests. Omitted in production so each assembly reads the real one.
 */
export function clockContext({ now } = {}) {
  return {
    name: CLOCK_CONTEXT_NAME,
    order: CLOCK_CONTEXT_ORDER,
    text: () => gnomonClockLine(now === undefined ? {} : { now }),
  };
}
