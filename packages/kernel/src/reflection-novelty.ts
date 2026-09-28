/**
 * Whether a reflection says something the last few did not.
 *
 * Twenty reflections in thirty days, one marked useful: "Claude-heavy afternoon
 * with rapid app switching" on Monday, "Claude-heavy day with rapid context
 * switching" on Tuesday, "Claude-heavy afternoon…" again on Wednesday. The
 * model is asked not to restate, and restates anyway, because the days really
 * are alike. The check belongs AFTER the call, on the title it produced: a
 * title that shares most of its words with a recent one is the same finding.
 *
 * Word overlap (Jaccard over lower-cased content words), not embeddings: the
 * repeats are near-verbatim, and a threshold a person can read is easier to
 * tune than a cosine.
 */
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'of', 'in', 'on', 'at', 'to', 'by', 'then', 'after', 'before', 'into', 'from', 'for', 'is', 'was', 'were']);

export function contentWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

/** Half the words in common is the same finding said again. */
export const REPEAT_THRESHOLD = 0.5;

/** The recent title this one repeats, or null when it is new. */
export function repeatsRecent(title: string, recentTitles: readonly string[], threshold = REPEAT_THRESHOLD): string | null {
  for (const recent of recentTitles) if (titleSimilarity(title, recent) >= threshold) return recent;
  return null;
}
