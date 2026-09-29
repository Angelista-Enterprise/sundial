// The memory-backed system-prompt context: what Gnomon knows about the owner,
// in every turn, before the owner has asked anything.
//
// dsh's `PromptContext.text` is SYNCHRONOUS — `string | (ctx) => string` — and
// the slice is built from database reads. So the provider returns a cached
// string and a refresher rebuilds it in the background: once at registration,
// then on an interval. The almanac page that asked for this
// (`enhancements/ambient-context-injection`, since retired; the loop is now
// `architecture/llm/tool-loop`) named the cache as the first of
// its two honest costs: an idle conversation must not re-run retrieval per
// message. The interval is the cache key here rather than the current moment,
// because a moment can stay open for an hour while a commitment closes or a
// wake-up fires.
//
// Before the first refresh lands the text is empty, which dsh treats as
// "contributes nothing" — the same turn the clock alone would have produced.
//
// Named exports only.
import { AMBIENT_CONTEXT_NAME, AMBIENT_CONTEXT_ORDER } from '@sundial/kernel/ambient-context.js';

export { AMBIENT_CONTEXT_NAME, AMBIENT_CONTEXT_ORDER };

/** How often the slice is rebuilt. A minute is far below any human turn cadence and far above the query cost. */
export const AMBIENT_REFRESH_MS = 60_000;

/**
 * @param options.build - async () => string; the slice's text. Injected so the
 *   cache is testable without a database.
 * @param options.onError - reports a failed refresh. The previous text is kept:
 *   a stale slice beats none, and a failing database is loud elsewhere.
 * @param options.refreshMs - interval; `0` disables the timer (tests, or a
 *   caller that refreshes by hand).
 * @param options.setTimer / clearTimer - injectable clocks, default to the globals.
 */
export function createAmbientContext({ build, onError = () => {}, refreshMs = AMBIENT_REFRESH_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (typeof build !== 'function') throw new Error('createAmbientContext needs a build function');

  let text = '';
  let refreshedAt = null;
  let inFlight = null;

  const refresh = () => {
    // Coalesce: a refresh already running IS the freshest answer available.
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(build)
      .then((next) => {
        if (typeof next === 'string') {
          text = next;
          refreshedAt = new Date().toISOString();
        }
      })
      .catch((error) => onError(error))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = refreshMs > 0 ? setTimer(refresh, refreshMs) : null;
  const disposed = false;

  return {
    context: {
      name: AMBIENT_CONTEXT_NAME,
      order: AMBIENT_CONTEXT_ORDER,
      text: () => text,
    },
    refresh,
    /** For the Trust surface and tests: when the slice was last rebuilt, or null. */
    refreshedAt: () => refreshedAt,
    dispose: () => {
      if (timer !== null && !disposed) clearTimer(timer);
    },
  };
}
