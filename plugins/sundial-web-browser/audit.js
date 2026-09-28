// The audit trail for everything this plugin does on the web.
//
// It goes into the SIGNAL LOG, not a private table. The log is already the
// append-only record every other observation enters through, it replays, it is
// retention- and purge-governed with the rest of the record, and it is
// readable today through `gnomon_signals(signalType: 'web')` — so "what did the
// assistant look at, and what came back" is answerable with the tool the model
// already has, rather than a new surface nobody queries.
//
// Two signal types, because they are two different acts:
//   web:fetch   — a specific URL was opened, because something named it.
//   web:search  — a query was put to a search engine, and these came back.
//
// Deliberately NOT `search:performed`: that type means "the owner searched",
// derived from their own browser window titles. Folding assistant queries into
// it would make the owner's search history lie, and every rule that reads it
// (moment rollup, entity extraction) would attribute the assistant's curiosity
// to the person.
//
// Every record is written whether the operation succeeded or failed, and is
// written AFTER the attempt, so it carries the outcome. A failed audit write is
// swallowed: an audit trail must not break the thing it observes.
//
// Named exports only.

/** Bound on recorded text — the trail says what happened, it is not a second copy of the web. */
export const MAX_RECORDED_SNIPPET = 500;

export function clip(text, max = MAX_RECORDED_SNIPPET) {
  const value = typeof text === 'string' ? text : '';
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Build the recorder.
 *
 * @param options.appendSignal `gnomonKernel.appendSignal` — ingest → reduce → effects
 * @param options.now clock, overridable in tests
 */
export function createWebAuditor({ appendSignal, now = () => new Date().toISOString() }) {
  async function record(type, payload) {
    try {
      await appendSignal(type, { timestamp: now(), ...payload });
    } catch (error) {
      console.error(`[sundial-web-browser] failed to record ${type}:`, error);
    }
  }

  return {
    /**
     * One fetch attempt.
     *
     * `url` is the URL ASKED FOR and `finalUrl` the one that answered — a
     * redirect chain is exactly the kind of thing an audit trail exists to
     * show, and collapsing them would hide it.
     */
    fetch({ url, finalUrl, statusCode, title, chars, truncated, durationMs, error }) {
      return record('web:fetch', {
        url,
        ...(finalUrl && finalUrl !== url ? { finalUrl } : {}),
        ...(typeof statusCode === 'number' ? { statusCode } : {}),
        ...(title ? { title: clip(title, 200) } : {}),
        ...(typeof chars === 'number' ? { chars } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        ok: !error,
        ...(error ? { error: clip(error, 300) } : {}),
      });
    },

    /** One search attempt, with the hosts it surfaced — enough to retrace a research trail. */
    search({ query, engine, resultCount, sources, durationMs, error }) {
      return record('web:search', {
        query: clip(query, 300),
        engine,
        ...(typeof resultCount === 'number' ? { resultCount } : {}),
        // Hosts, not full URLs: the trail should show WHERE an answer came
        // from without copying a result page into the log on every query.
        ...(Array.isArray(sources) && sources.length > 0 ? { hosts: uniqueHosts(sources) } : {}),
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        ok: !error,
        ...(error ? { error: clip(error, 300) } : {}),
      });
    },
  };
}

function uniqueHosts(sources) {
  const hosts = [];
  for (const source of sources) {
    try {
      const host = new URL(source.url).hostname;
      if (!hosts.includes(host)) hosts.push(host);
    } catch {
      // Not a URL we can name; leave it out of the host list.
    }
    if (hosts.length >= 10) break;
  }
  return hosts;
}
