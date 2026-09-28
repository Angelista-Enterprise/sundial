import { deriveId } from '@sundial/helpers/derive-id.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import type { Rule } from '@sundial/kernel/types.js';
import { closingMomentRow } from './moment-close.js';
import { momentEmbedText } from '@sundial/helpers/moment-embed-text.js';

/**
 * Proposes an `Embed` effect for a moment's text right as it's about to
 * close (docs/design/05-memory-and-knowledgebase.md §6) — same "runs before
 * `momentClose`" requirement as `contextSwitch`/`anomalyZscore`/
 * `entityExtract`, since it reads `state.moment` as the about-to-close one.
 * Text is the process name plus its rolled-up window titles — already
 * sanitized (this rule only ever sees post-`sanitizeAtIngest` state), so
 * nothing here re-derives redaction policy; it just picks which
 * already-safe fields become the embedded text.
 *
 * D2 (docs/audit/production-proposal-and-enhancements.md, fixes A§2.3) —
 * "one `Embed` per **closed** moment (not per window switch)": before this,
 * a same-process/same-project title change (B1's append, not a close) still
 * re-embedded the whole accumulating rollup on every title change, exactly
 * the per-window-switch volume D2 targets. See `moment-close.ts`'s
 * `isMomentClosingBoundary` doc comment for the fuller story (the same gap
 * affected three other sibling rules too).
 *
 * "One per closed moment" now means ALL five ways a moment closes, not just a
 * window boundary — see `closingMomentRow`, which this rule asks instead of
 * re-deriving the decision. Until that change every moment ended by idle,
 * sleep, the thirty-minute split or an unobserved-gap reconcile went unembedded,
 * so the retrieval index held the sub-minute window flicks and none of the long
 * undisturbed sessions.
 *
 * `knowledge_entries` get embedded separately, co-located in
 * `applyLlmResult`'s `companion` branch (the entry's id is generated right
 * there, so there's no reason to round-trip through another rule for it).
 */
export const embeddingIndex: Rule = (state, event) => {
  // No row means either nothing closed on this event, or the moment that did
  // close was under `MIN_MOMENT_DURATION_MS` and was dropped rather than
  // written — in which case there is no DB row for the embedding to point at.
  const closed = closingMomentRow(state, event);
  if (!closed || !state.moment) return { state, effects: [] };

  const { processName, rollup } = state.moment;
  // E3 (docs/audit/production-proposal-and-enhancements.md, fixes A§6.3) —
  // "skip intent/narrate/embed when the closing rollup is entirely
  // [private]/[hidden]" — same condition `momentAnalysisSchedule` checks,
  // over the rollup's window titles specifically (not `processName`, which
  // stays real content for a merely-sensitive-not-hidden app by design —
  // see `sanitize-at-ingest.ts`). A moment whose every title is a
  // placeholder has nothing in its content beyond what the bare process
  // name already conveys; embedding it anyway is a real row, paid for on
  // every future search scan, carrying no *additional* retrievable
  // information over what a plain process-name field already gives.
  if (rollup.windowTitles.length > 0 && rollup.windowTitles.every((t) => isRedactedPlaceholder(t))) {
    return { state, effects: [] };
  }

  // Pages (host/path) carry the tokens a title lacks — the repo, the ticket, the doc.
  // `spokenExcerpt` carries the tokens NOTHING else does: what was actually said
  // in the room. Without it a moment's whole ambient-hearing capture sat in the
  // `moments` row unreachable — `gnomon_semantic_search` scans `memory_embeddings`,
  // and the vector was built from window titles alone, so a search for a subject
  // discussed out loud but never typed matched nothing. It is already sanitized
  // (`momentRollup` drops `[private]` before it ever accumulates), so it is
  // appended, not re-filtered.
  // One builder for every place a moment is embedded (see `momentEmbedText`);
  // the narrative is not written yet at close, and re-embeds the moment when it is.
  const text = momentEmbedText(processName, rollup as unknown as Record<string, unknown>);

  return {
    state,
    effects: [{ type: 'Embed', id: deriveId(event.ts, event.id, 'embedding-index', closed.id), refType: 'moment', refId: closed.id, text }],
  };
};
