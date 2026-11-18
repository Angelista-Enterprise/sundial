/**
 * The ONE text a moment is embedded from — built at close by `embeddingIndex`,
 * again when its narrative lands, and by the scheme backfill. Two copies of
 * this list had already drifted once (`pages` in one and not the other).
 *
 * Order is the point: the local model reads roughly its first thousand
 * characters, so the densest field leads. Gnomon's narrative says what the
 * stretch was about in a sentence; then the app and window titles; what was
 * said aloud (the one field nothing else carries); pages; and a little of the
 * screen, last, because it is long and repetitive. Gnomon's own acts (the apps
 * it acted in and the goals it was given) come before the screen, so a search
 * for what Gnomon did finds the moment; a moment with none embeds the same text
 * as before, which is why the tag did not move. Everything here is already
 * sanitized at ingest; this only chooses and orders.
 */
export const MOMENT_TEXT_TAG = 't2';
const SCREEN_CHARS = 400;

export function momentEmbedText(processName: string | null | undefined, data: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const intent = (data.intent as { text?: unknown } | undefined)?.text;
  const acts = (data.acts ?? {}) as { apps?: unknown; goals?: unknown };
  const did = list(acts.apps).length + list(acts.goals).length > 0 ? `Gnomon acted in ${list(acts.apps).join(', ') || 'an app'}${list(acts.goals).length ? `: ${list(acts.goals).join('; ')}` : ''}` : '';
  return [str(data.narrative) || str(intent), processName ?? '', ...list(data.windowTitles), str(data.spokenExcerpt), ...list(data.pages), did, str(data.screenExcerpt).slice(0, SCREEN_CHARS)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** The `model` column for a moment's vector: the model, and which version of the text above it was built from. */
export const momentModelTag = (model: string): string => `${model}#${MOMENT_TEXT_TAG}`;

/** The vector space a stored `model` lives in — the tag says what text went in, not which space came out. */
export const embeddingSpace = (model: string): string => model.split('#')[0] ?? model;
