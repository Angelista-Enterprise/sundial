// The dsh agent's clock.
//
// A model has no clock, and the retired `/ask` said so outright: `nowLine`
// spelled out the date, yesterday's date, the weekday and the timezone in the
// context block the since-deleted `askContextBlock` built. The measured failure it fixes is on
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

/**
 * lane Q (Q12): one text per context per turn.
 *
 * dsh re-resolves every runtime context at each step and, when the joined text
 * differs from the last snapshot, appends the whole of it again as a user
 * message that stays in the history. The clock line changes every minute and
 * the ambient slice with it, so a turn of three tool steps that crossed a
 * minute carried two or three copies of the whole context. Frozen at the
 * turn's first step, a turn adds at most one; the next turn reads the clock
 * again.
 *
 * The turn is read off the agent dsh hands the resolver (`phase.turn` while it
 * runs). Anything else — no agent, an idle one, a shape this does not know —
 * resolves live, as before. Bounded: one entry per agent, the oldest dropped
 * past `MAX_FROZEN_AGENTS`.
 */
export const MAX_FROZEN_AGENTS = 64;
export function frozenPerTurn(context) {
  const frozen = new Map();
  const live = (assembly) => (typeof context.text === 'function' ? context.text(assembly) : context.text);
  return {
    ...context,
    text: (assembly) => {
      const agent = assembly?.agent;
      const turn = agent?.phase?.kind === 'running' ? agent.phase.turn : undefined;
      if (agent?.id === undefined || typeof turn !== 'number') return live(assembly);
      const held = frozen.get(agent.id);
      if (held?.turn === turn) return held.text;
      const text = live(assembly);
      frozen.delete(agent.id);
      frozen.set(agent.id, { turn, text });
      if (frozen.size > MAX_FROZEN_AGENTS) frozen.delete(frozen.keys().next().value);
      return text;
    },
  };
}
