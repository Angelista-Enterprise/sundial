// Ask the same question twice, get a handle the second time.
//
// The measured waste, from the live dsh session logs: 31 calls repeated a tool
// with byte-identical arguments inside ONE session — `gnomon_today_summary`
// with `date: '2026-09-12'` nine times, `date: '2026-09-11'` nine times,
// `gnomon_code_activity` for one project and one past day six times — worth
// 104,495 characters of results that said exactly what the earlier copy said.
//
// ## Append-only, and why that is the whole design
//
// The obvious fix is to rewrite the earlier result in place, or to drop it and
// keep the new one. Both are wrong here, and expensively so. The provider
// serves this conversation from a PREFIX cache: measured over the same logs,
// 85.5% of chat input tokens were cache reads, 95.8% at the median call. A
// cache matches from the start of the prompt up to the first byte that
// changed, so editing message 5 of 30 sends everything after it fresh. The 31
// calls in these logs that did miss the cache burned 1,242,408 fresh tokens —
// 15% of all fresh spend from 3% of calls, about 40,000 tokens each.
//
// So this never touches a message that has already been sent. It only makes
// the NEXT message smaller: a repeat call appends a ~40-token handle instead of
// a ~7,000-character result, and the full rows stay exactly where they were, in
// the cached prefix, still readable by the model.
//
// ## Only a past day is stubbed
//
// Staleness is the part that could quietly lie, so the rule is the narrowest
// one that covers the observed waste: a call is reusable only when it names a
// date STRICTLY BEFORE today in the owner's timezone. A finished day cannot
// change. Today can, and "now" questions (`gnomon_current_context`) must always
// re-read, so nothing undated is ever stubbed — no time-to-live, no window in
// which a stale "now" could be served as current. Every same-session repeat in
// the live logs was past-dated, so the narrow rule costs nothing.
//
// The date comparison is done at LOOKUP time, not at store time, so a session
// running past midnight stops stubbing the day that just ended only once it is
// genuinely over.
//
// ## What this deliberately does not catch
//
// Two identical calls dispatched in the SAME parallel batch both execute: the
// second looks up before the first has finished, so there is nothing to find.
// Deduplicating in flight would mean holding a promise per call and handing the
// second caller a handle to a result arriving in the same message — more
// machinery, and a handle whose "still above" is only just true.
//
// It is not worth it, and the logs say so. Of the 52 duplicate call pairs in
// them, 49 are in different steps and 3 are in the same batch. This takes the
// 49. Measured end to end on 2026-09-18, a repeated `gnomon_today_summary` for
// a past day came back as 638 characters instead of 7,783.
//
// Named exports only.

/** Stable key for a call: same tool, same arguments, whatever order they arrived in. */
export function callKey(toolName, args) {
  return `${toolName}(${stableStringify(args ?? {})})`;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` are one call and not two. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Is this call's answer fixed for the rest of the conversation?
 *
 * True only for an explicit `date` earlier than `today`. A missing date means
 * "now" or "the current day", both of which move; an equal date is today, which
 * is still being written. Anything malformed is treated as mutable — a
 * date-shaped string that does not parse is a reason to re-read, never a reason
 * to serve something old.
 */
export function isSettledCall(args, today) {
  const date = args?.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date < today;
}

/**
 * A one-line description of a result, for the handle to carry.
 *
 * The handle has to be useful on its own, not just a pointer. dsh compacts a
 * long conversation, and compaction can remove the very message a handle points
 * at; a bare "see step 3" would then be a reference to nothing. A digest means
 * the worst case is a model that knows the shape of the answer and asks a
 * narrower question, rather than one that believes it has already been told.
 */
export function digestOf(value) {
  if (value === null || typeof value !== 'object') return String(value);
  const parts = [];
  // The paging fields, where a tool has them: "25 of 412" is the single most
  // informative thing a result carries about its own size.
  if (typeof value.total === 'number') parts.push(`${value.count ?? '?'} of ${value.total} rows`);
  for (const [key, inner] of Object.entries(value)) {
    if (Array.isArray(inner) && inner.length > 0) parts.push(`${inner.length} ${key}`);
  }
  if (parts.length === 0) parts.push(`${Object.keys(value).length} fields`);
  return parts.slice(0, 4).join(', ');
}

/**
 * Per-session memory of what has already been answered.
 *
 * Bounded by `maxEntries` per session, oldest evicted first: a long session
 * must not grow an unbounded map, and the entries worth keeping are the recent
 * ones — an older result is more likely to have been compacted away anyway.
 *
 * @param options.maxEntries how many distinct calls one session remembers
 */
export function createHandleCache({ maxEntries = 128 } = {}) {
  /** sessionId → Map(callKey → { digest, step }) — insertion-ordered, so the first key is the oldest. */
  const bySession = new Map();

  return {
    /**
     * The handle for a call already answered in this session, or null.
     *
     * `today` is passed in rather than read here so the caller owns the
     * timezone, and so a test can make a day end.
     */
    lookup(sessionId, toolName, args, today) {
      if (!sessionId || !isSettledCall(args, today)) return null;
      const entry = bySession.get(sessionId)?.get(callKey(toolName, args));
      if (!entry) return null;
      return {
        ref: entry.ref,
        unchanged: true,
        digest: entry.digest,
        note: `You already called ${toolName} with exactly these arguments earlier in this conversation, and its full result is still above — read it there. ${args.date} is a finished day, so the answer has not changed. If you need different rows, change the arguments (a different offset, signalType, or project) rather than repeating this call.`,
      };
    },

    /** Record what a call answered, so a repeat of it can be a handle. */
    remember(sessionId, toolName, args, value, today) {
      if (!sessionId || !isSettledCall(args, today)) return;
      let session = bySession.get(sessionId);
      if (!session) {
        session = new Map();
        bySession.set(sessionId, session);
      }
      const key = callKey(toolName, args);
      // Re-inserted rather than updated, so a repeated call counts as recent
      // and survives eviction ahead of something asked once and forgotten.
      session.delete(key);
      session.set(key, { ref: key, digest: digestOf(value) });
      while (session.size > maxEntries) session.delete(session.keys().next().value);
    },

    /**
     * Forget a session's handles.
     *
     * Called on `compaction/end`: compaction rewrites the history, and a handle
     * that says "its full result is still above" must not outlive the message
     * it is talking about. Clearing costs one repeated tool call; not clearing
     * costs an answer built on evidence the model cannot actually see.
     */
    clear(sessionId) {
      if (sessionId) bySession.delete(sessionId);
      else bySession.clear();
    },

    /** Test seam: how many calls a session is currently remembering. */
    size(sessionId) {
      return bySession.get(sessionId)?.size ?? 0;
    },
  };
}
