// The model-facing text projection of a tool result.
//
// This is a verbatim port of `serializeResult` from
// packages/llm/src/tool-loop.ts — the exact text gnomon's own tool loop put
// in the `role: 'tool'` message. dsh's `output.render` fills the same seat
// (the Native/model rendering of the canonical value), so the model reads
// the same JSON text it read from the old `/ask` loop, including the loud
// truncation contract: a cut result SAYS it was cut and tells the model how
// to narrow its query, rather than presenting half the rows as all of them.
//
// Named exports only.

/** Same cap as the old loop's per-result budget (a heavy day of gnomon_code_activity measures ~8KB). */
export const MAX_RESULT_BYTES = 7_000;

/**
 * Serialize one tool result, truncating loudly rather than quietly.
 * Array-shaped results are halved into something still valid and still
 * useful; anything else too large is reported as too large with a preview,
 * because a truncated JSON string is not a smaller answer, it is a broken one.
 */
export function renderResultText(value, maxBytes = MAX_RESULT_BYTES) {
  const full = JSON.stringify(value ?? null);
  if (full.length <= maxBytes) return full;

  if (Array.isArray(value)) {
    const kept = [];
    let used = 0;
    for (const item of value) {
      const encoded = JSON.stringify(item);
      if (used + encoded.length > maxBytes * 0.8) break;
      kept.push(item);
      used += encoded.length;
    }
    return JSON.stringify({
      truncated: true,
      note: `showing ${kept.length} of ${value.length} rows — narrow your query (add a date, a project, or a smaller limit) to see the rest`,
      rows: kept,
    });
  }

  return JSON.stringify({
    truncated: true,
    note: `this result was ${full.length} bytes, over the ${maxBytes}-byte limit for one tool result — narrow your query (add a date, a project, or a smaller limit)`,
    preview: full.slice(0, Math.floor(maxBytes * 0.6)),
  });
}
