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

const ISO_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/;

/**
 * A UTC instant on the owner's wall clock, offset included:
 * "2026-09-30T19:00:00.000Z" in Amsterdam is "2026-09-30T21:00:00+02:00".
 * Tool rows carry UTC; a model told the timezone still read "due 19:00" as
 * the local hour (seen 2026-10-02). The offset keeps the instant exact.
 */
export function localIso(ts, timeZone) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const hm = (n) => String(n).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off < 0 ? '-' : '+'}${hm(Math.floor(Math.abs(off) / 60))}:${hm(Math.abs(off) % 60)}`;
}

/** Every UTC timestamp string in a result, at any depth, as `localIso` writes it. */
export function withLocalTimes(value, timeZone) {
  if (typeof value === 'string') return ISO_Z.test(value) ? localIso(value, timeZone) : value;
  if (Array.isArray(value)) return value.map((v) => withLocalTimes(v, timeZone));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withLocalTimes(v, timeZone)]));
  return value;
}
